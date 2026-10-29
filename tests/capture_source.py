"""The run capture format as its source package defines it, and the capture fixture.

The models mirror the source's data model, independent of `pydantic_ai_trace.run_capture`,
so the fixture is what that package dumps rather than what our model expects.
Regenerate the fixture with `pixi run python tests/capture_source.py`.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal, NewType

from pydantic import BaseModel, ConfigDict, Field
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage, RunUsage

FIXTURE = Path(__file__).parent / "fixtures" / "run_capture.json"

RunId = NewType("RunId", str)
PydanticRunId = NewType("PydanticRunId", str)
TrajectoryId = NewType("TrajectoryId", str)
ToolCallId = NewType("ToolCallId", str)


class AgentRunParent(BaseModel):
    kind: Literal["agent_run"] = "agent_run"
    run_id: RunId


class ToolCallParent(BaseModel):
    kind: Literal["tool_call"] = "tool_call"
    run_id: RunId
    tool_call_id: ToolCallId


class TrajectoryParent(BaseModel):
    kind: Literal["trajectory"] = "trajectory"
    trajectory_id: TrajectoryId


ParentRef = Annotated[
    AgentRunParent | ToolCallParent | TrajectoryParent, Field(discriminator="kind")
]


class ToolCallTiming(BaseModel):
    started_at: datetime
    duration_seconds: float | None = Field(default=None, ge=0)


class AgentRunTrace(BaseModel):
    model_config = ConfigDict(ser_json_bytes="base64", val_json_bytes="base64")
    id: RunId
    pydantic_run_id: PydanticRunId
    agent_name: str | None = None
    parent: ParentRef
    started_at: datetime
    ended_at: datetime | None = None
    status: Literal["running", "completed", "failed", "cancelled"] = "running"
    messages: list[ModelMessage] = []
    output: Any = None
    usage: RunUsage | None = None
    tool_call_timings: dict[ToolCallId, ToolCallTiming] = {}


class Trajectory(BaseModel):
    id: TrajectoryId
    runs: list[AgentRunTrace] = []


START = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)
TOP = TrajectoryParent(trajectory_id=TrajectoryId("capture-1"))
USAGE = RequestUsage(input_tokens=100, output_tokens=20)


def at(seconds: int) -> datetime:
    return START + timedelta(seconds=seconds)


def prompt(text: str, second: int, run_id: str | None) -> ModelRequest:
    return ModelRequest(
        parts=[UserPromptPart(content=text, timestamp=at(second))],
        timestamp=at(second),
        run_id=run_id,
    )


def response(*parts: TextPart | ToolCallPart, second: int, run_id: str) -> ModelResponse:
    return ModelResponse(
        parts=list(parts), usage=USAGE, model_name="gpt-4o", timestamp=at(second), run_id=run_id
    )


def returns(*parts: ToolReturnPart, second: int, run_id: str) -> ModelRequest:
    return ModelRequest(parts=list(parts), timestamp=at(second), run_id=run_id)


def tool_return(name: str, content: str, call_id: str, second: int) -> ToolReturnPart:
    return ToolReturnPart(name, content, call_id, timestamp=at(second))


def run(
    id: str,
    pydantic_run_id: str,
    parent: AgentRunParent | ToolCallParent | TrajectoryParent,
    *,
    started: int,
    ended: int | None,
    status: Literal["running", "completed", "failed", "cancelled"],
    messages: list[ModelMessage],
    name: str | None,
    output: Any = None,
    **fields: Any,
) -> AgentRunTrace:
    return AgentRunTrace(
        id=RunId(id),
        pydantic_run_id=PydanticRunId(pydantic_run_id),
        agent_name=name,
        parent=parent,
        started_at=at(started),
        ended_at=at(ended) if ended is not None else None,
        status=status,
        messages=messages,
        output=output,
        **fields,
    )


def capture() -> Trajectory:
    """A workflow covering every way a capture differs from a run tree.

    `orchestrator` starts `researcher` and `writer` by tool call and an unnamed output
    validator without one. `researcher` failed once and was retried under the same
    Pydantic run ID; the failed attempt had a child of its own. Both attempts inherit
    history. `writer` was cancelled, `summarizer` failed, `notifier` failed before
    producing a message, and `follow_up` is still running while its subagent `lookup`
    has ended.
    """
    question = prompt("Summarize the refund policy.", 0, "p-orch")
    orchestrator = run(
        "orch",
        "p-orch",
        TOP,
        started=0,
        ended=21,
        status="completed",
        name="orchestrator",
        output="Refunds are accepted within 30 days.",
        messages=[
            question,
            response(
                ToolCallPart("ask_researcher", {"q": "refund window"}, tool_call_id="c1"),
                ToolCallPart("ask_writer", {"draft": "summary"}, tool_call_id="c2"),
                second=1,
                run_id="p-orch",
            ),
            returns(
                tool_return("ask_researcher", "30 days", "c1", 12),
                tool_return("ask_writer", "cancelled", "c2", 15),
                second=16,
                run_id="p-orch",
            ),
            response(TextPart("Refunds are accepted within 30 days."), second=20, run_id="p-orch"),
        ],
        usage=RunUsage(requests=2, input_tokens=200, output_tokens=40),
        tool_call_timings={
            ToolCallId("c1"): ToolCallTiming(started_at=at(1), duration_seconds=11.0),
            ToolCallId("c2"): ToolCallTiming(started_at=at(1), duration_seconds=14.0),
        },
    )
    background = prompt("Background: the customer is in the EU.", 0, None)
    first_attempt = run(
        "research-1",
        "p-research",
        ToolCallParent(run_id=RunId("orch"), tool_call_id=ToolCallId("c1")),
        started=2,
        ended=5,
        status="failed",
        name="researcher",
        messages=[
            background,
            prompt("Find the refund window.", 2, "p-research"),
            response(ToolCallPart("search", {"q": "refunds"}, "c1"), second=3, run_id="p-research"),
        ],
    )
    first_attempt_check = run(
        "research-1-check",
        "p-check",
        AgentRunParent(run_id=RunId("research-1")),
        started=4,
        ended=5,
        status="completed",
        name="checker",
        messages=[
            prompt("Check the search query.", 4, "p-check"),
            response(TextPart("ok"), second=5, run_id="p-check"),
        ],
    )
    writer = run(
        "writer",
        "p-writer",
        ToolCallParent(run_id=RunId("orch"), tool_call_id=ToolCallId("c2")),
        started=2,
        ended=15,
        status="cancelled",
        name="writer",
        messages=[
            prompt("Draft a summary.", 2, "p-writer"),
            response(TextPart("Refunds are"), second=3, run_id="p-writer"),
        ],
    )
    second_attempt = run(
        "research-2",
        "p-research",
        ToolCallParent(run_id=RunId("orch"), tool_call_id=ToolCallId("c1")),
        started=6,
        ended=12,
        status="completed",
        name="researcher",
        output="30 days",
        messages=[
            background,
            question,
            prompt("Find the refund window.", 6, "p-research"),
            response(ToolCallPart("search", {"q": "refunds"}, "c1"), second=7, run_id="p-research"),
            returns(tool_return("search", "30 days", "c1", 9), second=9, run_id="p-research"),
            response(TextPart("30 days"), second=11, run_id="p-research"),
        ],
        usage=RunUsage(requests=2, input_tokens=200, output_tokens=40),
        tool_call_timings={
            ToolCallId("c1"): ToolCallTiming(started_at=at(7), duration_seconds=2.0)
        },
    )
    validator = run(
        "validate",
        "p-validate",
        AgentRunParent(run_id=RunId("orch")),
        started=17,
        ended=19,
        status="completed",
        name=None,
        output=True,
        messages=[
            prompt("Is the answer supported?", 17, "p-validate"),
            response(TextPart("yes"), second=18, run_id="p-validate"),
        ],
    )
    summarizer = run(
        "summarize",
        "p-summarize",
        TOP,
        started=22,
        ended=25,
        status="failed",
        name="summarizer",
        messages=[
            prompt("Summarize the run.", 22, "p-summarize"),
            response(TextPart("The run"), second=24, run_id="p-summarize"),
        ],
    )
    notifier = run(
        "notify",
        "p-notify",
        TOP,
        started=26,
        ended=27,
        status="failed",
        name="notifier",
        messages=[question],
    )
    follow_up = run(
        "follow-up",
        "p-follow",
        TOP,
        started=28,
        ended=None,
        status="running",
        name="follow_up",
        messages=[],
        tool_call_timings={ToolCallId("c1"): ToolCallTiming(started_at=at(29))},
    )
    lookup = run(
        "lookup",
        "p-lookup",
        ToolCallParent(run_id=RunId("follow-up"), tool_call_id=ToolCallId("c1")),
        started=29,
        ended=30,
        status="completed",
        name="lookup",
        output="found",
        messages=[
            prompt("Look up the order.", 29, "p-lookup"),
            response(TextPart("found"), second=30, run_id="p-lookup"),
        ],
    )
    # Recorded in start order, as runs are added when they start.
    runs = [
        orchestrator,
        first_attempt,
        writer,
        first_attempt_check,
        second_attempt,
        validator,
        summarizer,
        notifier,
        follow_up,
        lookup,
    ]
    return Trajectory(id=TrajectoryId("capture-1"), runs=runs)


def capture_json() -> str:
    return capture().model_dump_json(indent=2) + "\n"


if __name__ == "__main__":
    FIXTURE.write_text(capture_json())
