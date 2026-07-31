import json
from pathlib import Path

import pytest

from pydantic_ai_trace.text import format_trace_as_text

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(
    ("trace_path", "expected_path"),
    [
        (FIXTURES / "full_trace.json", FIXTURES / "full_trace.txt"),
        (
            FIXTURES / "runs" / "media_and_builtins.json",
            FIXTURES / "runs" / "media_and_builtins.txt",
        ),
        (FIXTURES / "text_edge_cases.json", FIXTURES / "text_edge_cases.txt"),
    ],
)
def test_formatter_matches_shared_golden(trace_path: Path, expected_path: Path):
    trace = json.loads(trace_path.read_text(encoding="utf-8"))
    assert format_trace_as_text(trace, trace_path.name) == expected_path.read_text(encoding="utf-8")


def test_non_array_input_formats_as_an_empty_trace():
    assert format_trace_as_text({"kind": "request"}, "broken.json") == (
        "========== TRACE ==========\n\nNAME: broken.json\nLLM CALLS: 0 | TOKENS: 0 in → 0 out\n"
    )


def test_repeated_instructions_are_only_printed_when_they_change():
    trace = [
        {"kind": "request", "instructions": "First.", "parts": []},
        {"kind": "request", "instructions": "First.", "parts": []},
        {"kind": "request", "instructions": None, "parts": []},
        {"kind": "request", "instructions": "Second.", "parts": []},
        {"kind": "request", "instructions": "Second.", "parts": []},
        {"kind": "request", "instructions": "First.", "parts": []},
    ]

    text = format_trace_as_text(trace, "instructions.json")

    assert text.count("--- INSTRUCTIONS ---") == 3
    assert text.count("First.") == 2
    assert text.count("Second.") == 1


def test_unknown_message_and_part_use_raw_json_fallbacks():
    trace = [
        {"kind": "telepathy", "parts": [], "payload": "message"},
        {"kind": "response", "parts": [{"future": True}]},
    ]
    text = format_trace_as_text(trace, "future.json")
    assert (
        "========== UNKNOWN MESSAGE ==========\n\n"
        '{"kind":"telepathy","parts":[],"payload":"message"}' in text
    )
    assert '--- UNKNOWN PART: unknown ---\n\n{"part_kind":"unknown","raw":{"future":true}}' in text


def test_integer_larger_than_javascript_number_range_matches_json_stringify():
    trace = [{"kind": "response", "parts": [{"part_kind": "future", "value": 10**400}]}]

    text = format_trace_as_text(trace, "huge.json")

    assert '--- UNKNOWN PART: future ---\n\n{"part_kind":"future","value":null}' in text
