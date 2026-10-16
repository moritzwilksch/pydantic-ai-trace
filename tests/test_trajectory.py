import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError
from pydantic_ai.messages import (
    BinaryContent,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from pydantic_ai_trace import Completed, Failed, Parent, Run, RunId, ToolCallId, Trajectory
from pydantic_ai_trace.payload import build_payload

FIXTURES = Path(__file__).parent / "fixtures"
START = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)


def at(seconds: int) -> datetime:
    return START + timedelta(seconds=seconds)


def exchange(start: int, end: int, *, call_id: str | None = None) -> list:
    response = (
        [ToolCallPart(tool_name="ask", args={}, tool_call_id=call_id)]
        if call_id
        else [TextPart(content="ok")]
    )
    return [
        ModelRequest(parts=[UserPromptPart(content="hi", timestamp=at(start))]),
        ModelResponse(parts=response, timestamp=at(end)),
    ]


def run(name: str, **fields: object) -> Run:
    defaults: dict[str, object] = {
        "id": RunId(name),
        "name": name,
        "parent": None,
        "started_at": at(0),
        "ended_at": at(1),
        "outcome": Completed(),
        "messages": tuple(exchange(0, 1)),
    }
    return Run.model_validate({**defaults, **fields})


class TestRunFromMessages:
    def test_takes_its_time_span_from_message_timestamps(self):
        built = Run.from_messages(exchange(2, 7), name="step")

        assert (built.started_at, built.ended_at) == (at(2), at(7))
        assert built.outcome == Completed()
        assert built.parent is None

    def test_accepts_a_json_dump_and_ignores_timestamps_validation_would_invent(self):
        dump = [
            {"kind": "request", "parts": [{"part_kind": "user-prompt", "content": "hi"}]},
            {
                "kind": "response",
                "timestamp": at(3).isoformat(),
                "parts": [{"part_kind": "text", "content": "ok"}],
            },
        ]

        built = Run.from_messages(dump, name="step")

        assert (built.started_at, built.ended_at) == (at(3), at(3))
        assert isinstance(built.messages[1], ModelResponse)

    def test_without_timestamps_is_rejected(self):
        dump = [{"kind": "request", "parts": [{"part_kind": "user-prompt", "content": "hi"}]}]

        with pytest.raises(ValueError, match="no message timestamps"):
            Run.from_messages(dump, name="step")

    def test_links_to_a_parent_and_its_tool_call(self):
        parent = Run.from_messages(exchange(0, 1, call_id="call_1"), name="parent")

        child = Run.from_messages(
            exchange(1, 2), name="child", parent=parent, tool_call_id="call_1"
        )

        assert child.parent == Parent(run_id=parent.id, tool_call_id=ToolCallId("call_1"))

    def test_tool_call_without_parent_is_rejected(self):
        with pytest.raises(ValueError, match="requires a parent"):
            Run.from_messages(exchange(0, 1), name="child", tool_call_id="call_1")

    def test_child_of_returns_a_linked_copy(self):
        parent = run("parent")
        child = run("child")

        linked = child.child_of(parent)

        assert linked.parent == Parent(run_id=RunId("parent"))
        assert child.parent is None

    def test_run_ids_default_to_unique_uuid7(self):
        first = Run.from_messages(exchange(0, 1), name="a")
        second = Run.from_messages(exchange(0, 1), name="a")

        assert first.id != second.id
        assert first.id[14] == "7"  # UUID version nibble


class TestTrajectory:
    def test_round_trips_through_json(self):
        text = (FIXTURES / "trajectory.json").read_text()

        trajectory = Trajectory.model_validate_json(text)

        assert Trajectory.model_validate_json(trajectory.model_dump_json()) == trajectory

    def test_roots_and_children_are_sorted_by_start(self):
        trajectory = Trajectory.model_validate_json((FIXTURES / "trajectory.json").read_text())

        assert [run.name for run in trajectory.roots()] == ["planner", "worker", "summarizer"]
        assert [run.name for run in trajectory.children(RunId("worker"))] == ["subagent"]

    def test_from_named_messages_builds_one_root_per_name(self):
        trajectory = Trajectory.from_named_messages(
            {"second": exchange(5, 6), "first": exchange(0, 1)}
        )

        assert [run.name for run in trajectory.runs] == ["first", "second"]  # end order
        assert all(run.parent is None for run in trajectory.runs)

    def test_from_named_messages_accepts_json_dumps(self):
        dump = ModelMessagesTypeAdapter.dump_python(exchange(0, 1), mode="json")

        trajectory = Trajectory.from_named_messages({"step": dump})

        assert trajectory.runs[0].name == "step"

    def test_duplicate_run_ids_are_rejected(self):
        with pytest.raises(ValidationError, match="duplicate run id 'a'"):
            Trajectory(runs=(run("a"), run("a")))

    def test_tool_call_missing_from_the_parent_is_rejected(self):
        child = run("child", parent=Parent(run_id=RunId("parent"), tool_call_id=ToolCallId("x")))

        with pytest.raises(ValidationError, match="does not contain"):
            Trajectory(runs=(child, run("parent")))

    def test_a_cycle_is_rejected(self):
        a = run("a", parent=Parent(run_id=RunId("b")))
        b = run("b", parent=Parent(run_id=RunId("a")))

        with pytest.raises(ValidationError, match="its own ancestor"):
            Trajectory(runs=(a, b))

    def test_a_child_recorded_before_its_parent_is_a_root(self):
        """Runs are recorded when they end, so a live file can lack the parent."""
        child = run("child", parent=Parent(run_id=RunId("parent"), tool_call_id=ToolCallId("x")))

        trajectory = Trajectory(runs=(child,))

        assert trajectory.roots() == [child]

    def test_outcomes_are_discriminated_by_status(self):
        failed = run("a", outcome={"status": "failed", "error_type": "E", "detail": "boom"})

        assert failed.outcome == Failed(error_type="E", detail="boom")

    def test_unknown_fields_are_rejected(self):
        with pytest.raises(ValidationError, match="Extra inputs"):
            Trajectory.model_validate({"runs": [], "version": 2})


class TestBytes:
    @pytest.mark.parametrize("content", [b"hello", b"\xff"])
    def test_serialize_like_pydantic_ais_adapter(self, content: bytes):
        messages: list[ModelMessage] = [
            ModelRequest(
                parts=[
                    ToolReturnPart(
                        tool_name="t", content=content, tool_call_id="c", timestamp=at(0)
                    )
                ]
            )
        ]
        trajectory = Trajectory.from_messages(messages)
        canonical = json.loads(ModelMessagesTypeAdapter.dump_json(messages))

        dumped = json.loads(trajectory.model_dump_json())
        payload = json.loads(build_payload(trajectory, name="t").to_json())

        assert dumped["runs"][0]["messages"] == canonical
        assert payload["trajectory"]["runs"][0]["messages"] == canonical

    def test_typed_bytes_round_trip(self):
        image = BinaryContent(data=b"\xff\x00", media_type="image/png")
        messages = [ModelRequest(parts=[UserPromptPart(content=[image], timestamp=at(0))])]
        trajectory = Trajectory.from_messages(messages)

        again = Trajectory.model_validate_json(trajectory.model_dump_json())

        # Pydantic AI narrows `BinaryContent` to `BinaryImage`; the bytes survive.
        [part] = again.runs[0].messages[0].parts
        assert isinstance(part, UserPromptPart) and not isinstance(part.content, str)
        [item] = part.content
        assert isinstance(item, BinaryContent) and item.data == b"\xff\x00"


def test_walk_visits_runs_depth_first_with_their_depth():
    trajectory = Trajectory.model_validate_json((FIXTURES / "trajectory.json").read_text())

    assert [(run.name, depth) for run, depth in trajectory.walk()] == [
        ("planner", 0),
        ("worker", 0),
        ("subagent", 1),
        ("summarizer", 0),
    ]
