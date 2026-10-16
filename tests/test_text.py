import json
from pathlib import Path

import pytest
from pydantic_ai.messages import ModelMessagesTypeAdapter

from pydantic_ai_trace.load import load_trajectory
from pydantic_ai_trace.payload import build_payload

FIXTURES = Path(__file__).parent / "fixtures"


def transcript(trace_json: str, name: str) -> str:
    return build_payload(load_trajectory(trace_json, name=name), name=name).transcript


def messages_json(messages: list[dict]) -> str:
    """Validate hand-written messages so tests use only shapes Pydantic AI accepts."""
    validated = ModelMessagesTypeAdapter.validate_python(messages)
    return ModelMessagesTypeAdapter.dump_json(validated).decode()


def request(*parts: dict, **fields: object) -> dict:
    return {"kind": "request", "timestamp": "2026-01-01T09:00:00Z", "parts": list(parts), **fields}


@pytest.mark.parametrize(
    ("trace_path", "expected_path"),
    [
        (FIXTURES / "full_trace.json", FIXTURES / "full_trace.txt"),
        (
            FIXTURES / "runs" / "media_and_builtins.json",
            FIXTURES / "runs" / "media_and_builtins.txt",
        ),
        (FIXTURES / "runs" / "tool_search.json", FIXTURES / "runs" / "tool_search.txt"),
        (FIXTURES / "text_edge_cases.json", FIXTURES / "text_edge_cases.txt"),
    ],
)
def test_formatter_matches_shared_golden(trace_path: Path, expected_path: Path):
    text = transcript(trace_path.read_text(encoding="utf-8"), trace_path.name)
    assert text == expected_path.read_text(encoding="utf-8")


def test_prompt_parts_keep_their_embedded_newlines_verbatim():
    text = transcript((FIXTURES / "newlines.json").read_text(encoding="utf-8"), "newlines.json")

    assert "First line.\nSecond line.\n\nA second paragraph." in text
    assert '```python\nprint("code one")\nprint("code two")\n```' in text
    assert "List form:\nline one\nline two\n\n\ttabbed indentation" in text
    assert "CRLF form:\r\nfirst\r\nsecond\r\n\r\nthird" in text
    assert "tool output line one\ntool output line two\n\nthird" in text


def test_repeated_instructions_are_only_printed_when_they_change():
    trace = messages_json(
        [
            request(instructions="First."),
            request(instructions="First."),
            request(instructions=None),
            request(instructions="Second."),
            request(instructions="Second."),
            request(instructions="First."),
        ]
    )

    text = transcript(trace, "instructions.json")

    assert text.count("--- INSTRUCTIONS ---") == 3
    assert text.count("First.") == 2
    assert text.count("Second.") == 1


def test_a_user_tool_sharing_a_framework_tool_name_is_not_reinterpreted():
    """pydantic-ai discriminates on `tool_kind`, never on `tool_name`; so does the formatter."""
    trace = messages_json(
        [
            {
                "kind": "response",
                "timestamp": "2026-01-01T09:00:00Z",
                "parts": [
                    {
                        "part_kind": "tool-call",
                        "tool_name": "search_tools",
                        "args": '{"queries": "not the framework shape"}',
                        "tool_call_id": "c1",
                    }
                ],
            }
        ]
    )

    text = transcript(trace, "lookalike.json")

    assert "QUERIES:" not in text
    assert 'ARGUMENTS:\n{"queries":"not the framework shape"}' in text


def test_a_trajectory_renders_each_run_in_tree_order():
    text = transcript((FIXTURES / "trajectory.json").read_text(encoding="utf-8"), "workflow")

    headings = [line for line in text.splitlines() if line.startswith("========== RUN:")]
    assert headings == [
        "========== RUN: planner ==========",
        "========== RUN: worker ==========",
        "========== RUN: subagent ==========",
        "========== RUN: summarizer ==========",
    ]
    assert "PARENT: worker via tool call call_1" in text
    assert "OUTCOME: completed" in text


def test_a_message_list_has_no_run_headings():
    text = transcript((FIXTURES / "full_trace.json").read_text(encoding="utf-8"), "t")

    assert "RUN:" not in text


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        (
            {"outcome": {"status": "failed", "error_type": "TimeoutError", "detail": "slow"}},
            "OUTCOME: failed · TimeoutError: slow",
        ),
        ({"outcome": {"status": "cancelled"}}, "OUTCOME: cancelled"),
        (
            {"parent": {"run_id": "later", "tool_call_id": "call_1"}},
            "PARENT: later (not recorded) via tool call call_1",
        ),
    ],
)
def test_a_single_run_keeps_its_outcome_and_parent(fields: dict, expected: str):
    run = {
        "id": "only",
        "name": "only",
        "parent": None,
        "started_at": "2026-01-01T09:00:00Z",
        "ended_at": "2026-01-01T09:00:01Z",
        "outcome": {"status": "completed"},
        "messages": json.loads(messages_json([request()])),
        **fields,
    }

    text = transcript(json.dumps({"runs": [run]}), "t")

    assert "RUN:" not in text
    assert expected in text.split("========== REQUEST 1")[0]
