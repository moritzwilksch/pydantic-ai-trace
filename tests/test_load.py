import json
from pathlib import Path

import pytest

from pydantic_ai_trace.load import SINGLE_RUN_ID, TraceLoadError, load_trajectory

FIXTURES = Path(__file__).parent / "fixtures"


def test_a_message_list_becomes_one_named_run():
    trajectory = load_trajectory((FIXTURES / "full_trace.json").read_text(), name="full")

    [run] = trajectory.runs
    assert run.id == SINGLE_RUN_ID
    assert run.name == "full"
    assert len(run.messages) == 6


def test_an_object_is_a_trajectory():
    trajectory = load_trajectory((FIXTURES / "trajectory.json").read_text(), name="ignored")

    assert [run.name for run in trajectory.runs] == ["planner", "subagent", "worker", "summarizer"]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("[", "not valid JSON"),
        ("[NaN]", "non-standard JSON constant"),
        ('[{"args": {"x": 1e400}}]', "number out of range: 1e400"),
        ('"text"', "expected a JSON array of messages or a trajectory object"),
        ("[]", "run 't' has no messages"),
        ('[{"kind": "telepathy", "parts": []}]', "0: Input tag 'telepathy'"),
        ('{"runs": []}', "runs: Tuple should have at least 1 item"),
    ],
)
def test_invalid_text_names_the_first_problem(text: str, message: str):
    with pytest.raises(TraceLoadError, match=message):
        load_trajectory(text, name="t")


def test_naive_and_aware_timestamps_load_as_utc():
    text = (
        '[{"kind": "request", "timestamp": "2026-01-01T09:00:00",'
        ' "parts": [{"part_kind": "user-prompt", "content": "hi",'
        ' "timestamp": "2026-01-01T09:00:05Z"}]}]'
    )

    [run] = load_trajectory(text, name="t").runs

    assert (run.started_at.isoformat(), run.ended_at.isoformat()) == (
        "2026-01-01T09:00:00+00:00",
        "2026-01-01T09:00:05+00:00",
    )


def test_runs_with_naive_and_aware_times_order_together():
    trajectory = load_trajectory((FIXTURES / "trajectory.json").read_text(), name="t")
    data = trajectory.model_dump(mode="json")
    data["runs"][0]["started_at"] = "2026-01-01T09:00:00"  # naive, read as UTC

    reloaded = load_trajectory(json.dumps(data), name="t")

    assert [run.name for run in reloaded.roots()] == ["planner", "worker", "summarizer"]
