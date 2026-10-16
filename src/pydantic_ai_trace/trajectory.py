"""The trajectory format: an agent workflow as a tree of runs.

A workflow is its top-level runs. A subagent is a run whose parent is another run
and, usually, one of that run's tool calls. Runs are recorded when they end, so a
trajectory written mid-workflow may hold runs whose parent has not been recorded yet.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Annotated, Any, Literal, NewType, Self

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator
from pydantic_ai.messages import BaseToolCallPart, ModelMessage, ModelMessagesTypeAdapter
from uuid_utils import uuid7

RunId = NewType("RunId", str)  # Unique in its trajectory; UUID7 by default.
ToolCallId = NewType("ToolCallId", str)  # Unique only within its parent run.

type MessagesLike = Sequence[ModelMessage] | Sequence[Mapping[str, Any]]
"""Pydantic AI messages, or their JSON-compatible dump."""


def new_run_id() -> RunId:
    return RunId(str(uuid7()))


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class Parent(_Frozen):
    run_id: RunId
    # The tool call in the parent that started this run. None for a nested run not
    # started by a tool, such as an output validator.
    tool_call_id: ToolCallId | None = None


class Completed(_Frozen):
    status: Literal["completed"] = "completed"
    output: JsonValue = None


class Failed(_Frozen):
    status: Literal["failed"] = "failed"
    error_type: str
    detail: str


class Cancelled(_Frozen):
    status: Literal["cancelled"] = "cancelled"


Outcome = Annotated[Completed | Failed | Cancelled, Field(discriminator="status")]


class Run(_Frozen):
    # Nested stdlib dataclasses inherit this config. Ignoring extras validates messages
    # exactly as `ModelMessagesTypeAdapter` does, so newer dumps still load.
    model_config = ConfigDict(frozen=True, extra="ignore")

    id: RunId = Field(default_factory=new_run_id)
    name: str
    parent: Parent | None  # None for a workflow step.
    started_at: datetime
    ended_at: datetime
    outcome: Outcome
    # Only the messages this run produced, without inherited history.
    messages: Annotated[tuple[ModelMessage, ...], Field(min_length=1)]

    @classmethod
    def from_messages(
        cls,
        messages: MessagesLike,
        *,
        name: str,
        parent: Run | None = None,
        tool_call_id: str | None = None,
        outcome: Outcome | None = None,
        id: RunId | None = None,
    ) -> Self:
        """Build a run whose start and end come from its message timestamps."""
        items = list(messages)
        if not items:
            raise ValueError(f"run {name!r} has no messages")
        validated = ModelMessagesTypeAdapter.validate_python(items)
        # Read timestamps from the input: validation fills missing ones with the current time.
        timestamps = [timestamp for message in items for timestamp in _timestamps(message)]
        if not timestamps:
            raise ValueError(f"run {name!r} has no message timestamps; construct Run directly")
        if tool_call_id is not None and parent is None:
            raise ValueError("tool_call_id requires a parent run")
        return cls(
            id=id or new_run_id(),
            name=name,
            parent=_parent(parent, tool_call_id),
            started_at=min(timestamps),
            ended_at=max(timestamps),
            outcome=outcome or Completed(),
            messages=tuple(validated),
        )

    def child_of(self, parent: Run, *, tool_call_id: str | None = None) -> Self:
        """This run, nested under `parent` and optionally started by one of its tool calls."""
        return self.model_copy(update={"parent": _parent(parent, tool_call_id)})


class Trajectory(_Frozen):
    # End order. Sort siblings by `started_at`.
    runs: Annotated[tuple[Run, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _check_tree(self) -> Self:
        by_id: dict[RunId, Run] = {}
        for run in self.runs:
            if run.id in by_id:
                raise ValueError(f"duplicate run id {run.id!r}")
            by_id[run.id] = run
        for run in self.runs:
            parent = by_id.get(run.parent.run_id) if run.parent is not None else None
            if parent is None or run.parent is None or run.parent.tool_call_id is None:
                continue
            if run.parent.tool_call_id not in _tool_call_ids(parent):
                raise ValueError(
                    f"run {run.id!r} names tool call {run.parent.tool_call_id!r}, "
                    f"which run {parent.id!r} does not contain"
                )
        for run in self.runs:
            seen = {run.id}
            current = run
            while current.parent is not None and current.parent.run_id in by_id:
                current = by_id[current.parent.run_id]
                if current.id in seen:
                    raise ValueError(f"run {run.id!r} is its own ancestor")
                seen.add(current.id)
        return self

    @classmethod
    def from_messages(cls, messages: MessagesLike, *, name: str = "run") -> Self:
        """A trajectory of one run."""
        return cls(runs=(Run.from_messages(messages, name=name),))

    @classmethod
    def from_named_messages(cls, runs: Mapping[str, MessagesLike]) -> Self:
        """One top-level run per name, such as the steps of a workflow."""
        built = [Run.from_messages(messages, name=name) for name, messages in runs.items()]
        return cls(runs=tuple(sorted(built, key=lambda run: run.ended_at)))

    def roots(self) -> list[Run]:
        """Top-level runs, including runs whose parent is not recorded yet."""
        ids = {run.id for run in self.runs}
        return sorted(
            (run for run in self.runs if run.parent is None or run.parent.run_id not in ids),
            key=lambda run: run.started_at,
        )

    def children(self, run_id: RunId) -> list[Run]:
        return sorted(
            (run for run in self.runs if run.parent is not None and run.parent.run_id == run_id),
            key=lambda run: run.started_at,
        )


def _parent(parent: Run | None, tool_call_id: str | None) -> Parent | None:
    if parent is None:
        return None
    return Parent(
        run_id=parent.id,
        tool_call_id=ToolCallId(tool_call_id) if tool_call_id is not None else None,
    )


def _timestamps(message: ModelMessage | Mapping[str, Any]) -> list[datetime]:
    """Timestamps of a message and its parts, from objects or from their JSON dump."""
    if isinstance(message, Mapping):
        parts = message.get("parts")
        candidates = (
            [
                message.get("timestamp"),
                *(part.get("timestamp") for part in parts if isinstance(part, Mapping)),
            ]
            if isinstance(parts, list)
            else [message.get("timestamp")]
        )
    else:
        candidates = [
            message.timestamp,
            *(getattr(part, "timestamp", None) for part in message.parts),
        ]
    return [timestamp for value in candidates if (timestamp := _datetime(value)) is not None]


def _datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _tool_call_ids(run: Run) -> set[str]:
    return {
        part.tool_call_id
        for message in run.messages
        for part in message.parts
        if isinstance(part, BaseToolCallPart)
    }
