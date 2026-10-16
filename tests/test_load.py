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
        ('"text"', "expected a JSON array of messages or a trajectory object"),
        ("[]", "run 't' has no messages"),
        ('[{"kind": "telepathy", "parts": []}]', "0: Input tag 'telepathy'"),
        ('{"runs": []}', "runs: Tuple should have at least 1 item"),
    ],
)
def test_invalid_text_names_the_first_problem(text: str, message: str):
    with pytest.raises(TraceLoadError, match=message):
        load_trajectory(text, name="t")
