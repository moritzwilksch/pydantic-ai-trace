"""The run capture format: a live recording of agent runs, converted to a `RunTree` to view.

Instrumentation writes a run capture while a workflow runs. It records every attempt of a
run, runs still in progress, each run's full message history, and tool timings. A
`RunTree` holds finished runs and only their own messages, so `to_run_tree` keeps what it
can show and drops the rest:

- Of the attempts that share a `pydantic_run_id`, only the last started counts. Earlier
  attempts and their descendants are dropped.
- A run still running, or one that produced no messages of its own, is dropped. Its
  children stay, shown as runs whose parent is not recorded.
- A run's messages are only those whose `run_id` is its `pydantic_run_id`; inherited
  history is dropped.
- A failed run records no error, so its `Failed` outcome says so.
- `usage`, `tool_call_timings`, `pydantic_run_id`, and the capture's `id` have no home in a
  `RunTree` and are dropped.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator
from pydantic_ai.messages import ModelMessage
from pydantic_ai.usage import RunUsage

from .run_tree import (
    MESSAGE_BYTES_CONFIG,
    Cancelled,
    Completed,
    Failed,
    Outcome,
    Parent,
    Run,
    RunId,
    RunTree,
    ToolCallId,
    UtcDatetime,
)

UNNAMED_RUN = "run"
UNRECORDED_ERROR = Failed(error_type="unknown", detail="not recorded in the run capture")


class _Strict(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class AgentRunParent(_Strict):
    """A nested run not started by a tool call, such as an output validator."""

    kind: Literal["agent_run"] = "agent_run"
    run_id: RunId


class ToolCallParent(_Strict):
    kind: Literal["tool_call"] = "tool_call"
    run_id: RunId
    tool_call_id: ToolCallId


class TrajectoryParent(_Strict):
    """A top-level run."""

    kind: Literal["trajectory"] = "trajectory"
    trajectory_id: str


CapturedParent = Annotated[
    AgentRunParent | ToolCallParent | TrajectoryParent, Field(discriminator="kind")
]


class ToolCallTiming(_Strict):
    started_at: UtcDatetime
    duration_seconds: Annotated[float, Field(ge=0)] | None = None


class CapturedRun(BaseModel):
    # As in `Run`: nested message dataclasses inherit this config, and ignoring extras
    # validates them exactly as `ModelMessagesTypeAdapter` does.
    model_config = ConfigDict(frozen=True, extra="ignore") | MESSAGE_BYTES_CONFIG

    id: RunId
    pydantic_run_id: str  # Shared by the attempts of one run.
    agent_name: str | None = None
    parent: CapturedParent
    started_at: UtcDatetime
    ended_at: UtcDatetime | None = None
    status: Literal["running", "completed", "failed", "cancelled"] = "running"
    messages: tuple[ModelMessage, ...] = ()  # May start with inherited history.
    output: JsonValue = None
    usage: RunUsage | None = None
    tool_call_timings: dict[ToolCallId, ToolCallTiming] = {}

    @model_validator(mode="after")
    def _ended_unless_running(self) -> Self:
        if (self.status == "running") != (self.ended_at is None):
            raise ValueError("ended_at must be set exactly when the run is not running")
        return self

    def own_messages(self) -> tuple[ModelMessage, ...]:
        return tuple(message for message in self.messages if message.run_id == self.pydantic_run_id)


class RunCapture(_Strict):
    id: str
    runs: tuple[CapturedRun, ...] = ()

    def to_run_tree(self) -> RunTree:
        kept = [
            _converted(run)
            for run in self._latest_attempts()
            if run.status != "running" and run.own_messages()
        ]
        if not kept:
            raise ValueError(f"run capture {self.id!r} has no ended run with messages")
        return RunTree(runs=tuple(sorted(kept, key=lambda run: run.ended_at)))

    def _latest_attempts(self) -> list[CapturedRun]:
        """Runs that are the last started attempt of their run, as are all their recorded
        ancestors."""
        by_id: dict[RunId, CapturedRun] = {}
        for run in self.runs:
            if run.id in by_id:
                raise ValueError(f"duplicate run id {run.id!r}")
            by_id[run.id] = run
        # Last started wins; on a tie, the one recorded later.
        latest: dict[str, CapturedRun] = {}
        for run in sorted(self.runs, key=lambda run: run.started_at):
            latest[run.pydantic_run_id] = run
        kept: dict[RunId, bool] = {}
        for run in self.runs:
            # Walk up to a run whose verdict is known, then decide the path top-down, so
            # long chains stay linear.
            path: list[CapturedRun] = []
            on_path: set[RunId] = set()
            current: CapturedRun | None = run
            while current is not None and current.id not in kept:
                if current.id in on_path:
                    raise ValueError(f"run {current.id!r} is its own ancestor")
                path.append(current)
                on_path.add(current.id)
                current = _recorded_parent(current, by_id)
            verdict = kept[current.id] if current is not None else True
            for step in reversed(path):
                verdict = verdict and latest[step.pydantic_run_id] is step
                kept[step.id] = verdict
        return [run for run in self.runs if kept[run.id]]


def _recorded_parent(run: CapturedRun, by_id: dict[RunId, CapturedRun]) -> CapturedRun | None:
    if isinstance(run.parent, TrajectoryParent):
        return None
    return by_id.get(run.parent.run_id)


def _converted(run: CapturedRun) -> Run:
    assert run.ended_at is not None  # Only running runs lack an end, and they are dropped.
    return Run(
        id=run.id,
        name=run.agent_name or UNNAMED_RUN,
        parent=_parent(run.parent),
        started_at=run.started_at,
        ended_at=run.ended_at,
        outcome=_outcome(run),
        messages=run.own_messages(),
    )


def _parent(parent: CapturedParent) -> Parent | None:
    match parent:
        case TrajectoryParent():
            return None
        case AgentRunParent(run_id=run_id):
            return Parent(run_id=run_id)
        case ToolCallParent(run_id=run_id, tool_call_id=tool_call_id):
            return Parent(run_id=run_id, tool_call_id=tool_call_id)


def _outcome(run: CapturedRun) -> Outcome:
    if run.status == "completed":
        return Completed(output=run.output)
    if run.status == "failed":
        return UNRECORDED_ERROR
    return Cancelled()
