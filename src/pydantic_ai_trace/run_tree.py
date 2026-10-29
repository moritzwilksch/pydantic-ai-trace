"""The run tree format: an agent workflow as a tree of runs.

A workflow is its top-level runs. A subagent is a run whose parent is another run
and, usually, one of that run's tool calls. Runs are recorded when they end, so a
run_tree written mid-workflow may hold runs whose parent has not been recorded yet.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from functools import cached_property
from typing import Annotated, Any, Literal, NewType, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, JsonValue, model_validator
from pydantic_ai.messages import BaseToolCallPart, ModelMessage, ModelMessagesTypeAdapter
from uuid_utils import uuid7

RunId = NewType("RunId", str)  # Unique in its run tree; UUID7 by default.
ToolCallId = NewType("ToolCallId", str)  # Unique only within its parent run.

type MessagesLike = Sequence[ModelMessage] | Sequence[Mapping[str, Any]]
"""Pydantic AI messages, or their JSON-compatible dump."""


def _as_utc(value: datetime) -> datetime:
    """Read a naive timestamp as UTC, so naive and aware timestamps compare."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


type UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


def new_run_id() -> RunId:
    return RunId(str(uuid7()))


# Pydantic AI writes bytes in messages as base64 in JSON. Byte settings apply from the
# model being (de)serialized, so every model that can hold messages repeats them.
MESSAGE_BYTES_CONFIG = ConfigDict(ser_json_bytes="base64", val_json_bytes="base64")


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid") | MESSAGE_BYTES_CONFIG


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
    model_config = ConfigDict(frozen=True, extra="ignore") | MESSAGE_BYTES_CONFIG

    id: RunId = Field(default_factory=new_run_id)
    name: str
    parent: Parent | None  # None for a workflow step.
    started_at: UtcDatetime
    ended_at: UtcDatetime
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


class RunTree(_Frozen):
    # End order. `roots`, `children`, and `walk` give tree order.
    runs: Annotated[tuple[Run, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _check_tree(self) -> Self:
        by_id: dict[RunId, Run] = {}
        for run in self.runs:
            if run.id in by_id:
                raise ValueError(f"duplicate run id {run.id!r}")
            by_id[run.id] = run
        # Count each parent's calls once; a parent can start thousands of children.
        call_counts: dict[RunId, Counter[str]] = {}
        for run in self.runs:
            parent = by_id.get(run.parent.run_id) if run.parent is not None else None
            if parent is None or run.parent is None or run.parent.tool_call_id is None:
                continue
            # Results pair with a reused call ID in order, but a child names the call by
            # ID alone, so it must name exactly one call.
            if parent.id not in call_counts:
                call_counts[parent.id] = _tool_call_counts(parent)
            calls = call_counts[parent.id][run.parent.tool_call_id]
            if calls != 1:
                found = "does not contain" if calls == 0 else f"contains {calls} times"
                raise ValueError(
                    f"run {run.id!r} names tool call {run.parent.tool_call_id!r}, "
                    f"which run {parent.id!r} {found}"
                )
        # Walk up from each run; a run whose ancestry is already known to end stops early,
        # so long chains stay linear.
        acyclic: set[RunId] = set()
        for run in self.runs:
            path: list[RunId] = []
            current: Run | None = run
            while current is not None and current.id not in acyclic:
                if current.id in path:
                    raise ValueError(f"run {current.id!r} is its own ancestor")
                path.append(current.id)
                current = by_id.get(current.parent.run_id) if current.parent else None
            acyclic.update(path)
        return self

    @classmethod
    def from_messages(cls, messages: MessagesLike, *, name: str = "run") -> Self:
        """A run tree of one run."""
        return cls(runs=(Run.from_messages(messages, name=name),))

    @classmethod
    def from_named_messages(cls, runs: Mapping[str, MessagesLike]) -> Self:
        """One top-level run per name, such as the steps of a workflow."""
        built = [Run.from_messages(messages, name=name) for name, messages in runs.items()]
        return cls(runs=tuple(sorted(built, key=lambda run: run.ended_at)))

    def roots(self) -> list[Run]:
        """Top-level runs, including runs whose parent is not recorded yet."""
        return self._children[None]

    def children(self, run_id: RunId) -> list[Run]:
        return self._children.get(run_id, [])

    def walk(self) -> list[tuple[Run, int]]:
        """Every run depth-first in tree order, with its depth (0 for top-level runs)."""
        walked: list[tuple[Run, int]] = []
        # An explicit stack, because a run tree can be deeper than Python's recursion limit.
        stack = [(root, 0) for root in reversed(self.roots())]
        while stack:
            run, depth = stack.pop()
            walked.append((run, depth))
            stack.extend((child, depth + 1) for child in reversed(self.children(run.id)))
        return walked

    @cached_property
    def _children(self) -> dict[RunId | None, list[Run]]:
        """Children by parent ID in tree order; roots are under `None`.

        Siblings sort by start, except that runs started by tool calls fill their slots
        in the order of those calls, so parallel calls read in the order the model made
        them.
        """
        by_id = {run.id: run for run in self.runs}
        children: dict[RunId | None, list[Run]] = {None: []}
        for run in sorted(self.runs, key=lambda run: run.started_at):
            parent_id = run.parent.run_id if run.parent and run.parent.run_id in by_id else None
            children.setdefault(parent_id, []).append(run)
        for parent_id, siblings in children.items():
            if parent_id is None:
                continue
            position = _tool_call_positions(by_id[parent_id])
            slots = [
                (index, position[run.parent.tool_call_id], run)
                for index, run in enumerate(siblings)
                if run.parent is not None and run.parent.tool_call_id is not None
            ]
            # Stable: runs started by the same call keep their start order.
            called = sorted(slots, key=lambda slot: slot[1])
            for (index, _, _), (_, _, run) in zip(slots, called, strict=True):
                siblings[index] = run
        return children


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
        return _as_utc(value)
    if not isinstance(value, str):
        return None
    try:
        return _as_utc(datetime.fromisoformat(value))
    except ValueError:
        return None


def _tool_call_positions(run: Run) -> dict[str, int]:
    """Each tool call ID's position among the run's tool calls."""
    ids = [
        part.tool_call_id
        for message in run.messages
        for part in message.parts
        if isinstance(part, BaseToolCallPart)
    ]
    return {call_id: index for index, call_id in reversed(list(enumerate(ids)))}


def _tool_call_counts(run: Run) -> Counter[str]:
    return Counter(
        part.tool_call_id
        for message in run.messages
        for part in message.parts
        if isinstance(part, BaseToolCallPart)
    )
