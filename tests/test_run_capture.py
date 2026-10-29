import json
from typing import Any

import pytest
from capture_source import FIXTURE, capture_json
from pydantic_ai.messages import UserPromptPart

from pydantic_ai_trace import Cancelled, Completed, Failed, Parent, RunId, ToolCallId
from pydantic_ai_trace.analysis import analyze
from pydantic_ai_trace.load import NotATraceError, TraceLoadError, load_run_tree
from pydantic_ai_trace.text import format_transcript


def fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


def load(data: dict[str, Any]):
    return load_run_tree(json.dumps(data), name="capture")


def test_the_fixture_is_what_the_source_models_dump():
    assert FIXTURE.read_text() == capture_json()


def test_a_capture_loads_as_a_run_tree_of_its_latest_ended_runs():
    run_tree = load_run_tree(FIXTURE.read_text(), name="capture")

    assert [(run.id, run.name, depth) for run, depth in run_tree.walk()] == [
        ("orch", "orchestrator", 0),
        ("research-2", "researcher", 1),
        ("writer", "writer", 1),
        ("validate", "run", 1),
        ("summarize", "summarizer", 0),
        ("lookup", "lookup", 0),
    ]


def test_parents_keep_the_tool_call_that_started_a_run():
    runs = {run.id: run for run in load(fixture()).runs}

    assert runs[RunId("orch")].parent is None
    assert runs[RunId("research-2")].parent == Parent(
        run_id=RunId("orch"), tool_call_id=ToolCallId("c1")
    )
    assert runs[RunId("validate")].parent == Parent(run_id=RunId("orch"))
    # A running parent has no messages yet, so its subagent shows as not recorded.
    assert runs[RunId("lookup")].parent == Parent(
        run_id=RunId("follow-up"), tool_call_id=ToolCallId("c1")
    )


def test_outcomes_follow_the_status():
    runs = {run.id: run for run in load(fixture()).runs}

    assert runs[RunId("orch")].outcome == Completed(output="Refunds are accepted within 30 days.")
    assert runs[RunId("validate")].outcome == Completed(output=True)
    assert runs[RunId("writer")].outcome == Cancelled()
    assert runs[RunId("summarize")].outcome == Failed(
        error_type="unknown", detail="not recorded in the run capture"
    )
    assert runs[RunId("orch")].ended_at.isoformat() == "2026-01-01T09:00:21+00:00"


def test_a_run_holds_only_its_own_messages():
    runs = {run.id: run for run in load(fixture()).runs}
    researcher = runs[RunId("research-2")]

    assert len(researcher.messages) == 4
    first = researcher.messages[0].parts[0]
    assert isinstance(first, UserPromptPart)
    assert first.content == "Find the refund window."


def test_a_capture_renders_as_a_text_transcript():
    run_tree = load(fixture())

    text = format_transcript(run_tree, analyze(run_tree), "capture")

    assert "PARENT: orchestrator (orch) · RESPONSE 1 · TOOL CALL: ask_researcher" in text
    assert "OUTCOME: failed · unknown: not recorded in the run capture" in text
    assert "PARENT: follow-up (not recorded) via tool call c1" in text
    assert "Background: the customer is in the EU." not in text


def test_a_retry_started_later_replaces_the_earlier_attempt_even_when_recorded_first():
    data = fixture()
    data["runs"].reverse()

    ids = {run.id for run in load(data).runs}

    assert "research-2" in ids
    assert "research-1" not in ids
    assert "research-1-check" not in ids


def test_a_capture_without_an_ended_run_is_a_broken_trace():
    data = fixture()
    data["runs"] = [run for run in data["runs"] if run["id"] == "follow-up"]

    with pytest.raises(TraceLoadError, match="run capture 'capture-1' has no ended run") as info:
        load(data)

    assert not isinstance(info.value, NotATraceError)


def test_an_object_with_only_an_id_is_not_a_trace():
    with pytest.raises(NotATraceError):
        load_run_tree('{"id": "capture-1"}', name="t")


def edit_run(data: dict[str, Any], run_id: str, **fields: Any) -> dict[str, Any]:
    [run] = [run for run in data["runs"] if run["id"] == run_id]
    run.update(fields)
    return data


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({**fixture(), "extra": 1}, "extra: Extra inputs are not permitted"),
        (
            edit_run(fixture(), "orch", ended_at=None),
            "ended_at must be set exactly when the run is not running",
        ),
        (
            edit_run(fixture(), "orch", parent={"kind": "agent_run", "run_id": "research-2"}),
            "is its own ancestor",
        ),
        (edit_run(fixture(), "writer", id="orch"), "duplicate run id 'orch'"),
        (
            edit_run(
                fixture(),
                "writer",
                parent={"kind": "tool_call", "run_id": "orch", "tool_call_id": "c9"},
            ),
            "names tool call 'c9', which run 'orch' does not contain",
        ),
    ],
)
def test_loading_a_capture_is_strict(data: dict[str, Any], message: str):
    with pytest.raises(TraceLoadError, match=message):
        load(data)


def test_an_unknown_part_kind_suggests_an_upgrade():
    data = fixture()
    data["runs"][0]["messages"][0]["parts"][0]["part_kind"] = "telepathy"

    with pytest.raises(TraceLoadError, match="does not know 'telepathy'"):
        load(data)
