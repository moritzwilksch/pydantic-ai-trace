import json
from pathlib import Path

from pydantic_ai_trace.trajectory import compact_trajectory, parse_trace

FIXTURES = Path(__file__).parent / "fixtures"


def test_compact_trajectory_preserves_order_and_useful_fields():
    raw = json.loads((FIXTURES / "full_trace.json").read_text(encoding="utf-8"))

    document = compact_trajectory(parse_trace(raw), name="full_trace.json")

    assert document["name"] == "full_trace.json"
    assert document["stats"] == {
        "llm_calls": 3,
        "tokens": {"input": 930, "output": 165, "cache_write": 100},
        "wall_time_seconds": 6.0,
    }
    messages = document["messages"]
    assert isinstance(messages, list)
    assert [message["type"] for message in messages] == [
        "request",
        "response",
        "request",
        "response",
        "request",
        "response",
    ]
    first_response = messages[1]
    assert first_response["model"] == "gpt-5"
    assert first_response["provider"] == "openai"
    assert first_response["finish_reason"] == "tool_call"
    assert first_response["usage"] == {
        "input": 220,
        "output": 55,
        "cache_write": 100,
        "details": {"reasoning_tokens": 24},
    }
    assert first_response["parts"][1] == {
        "type": "tool_call",
        "name": "lookup_population",
        "id": "call_berlin",
        "args": {"city": "Berlin"},
    }
    assert messages[2]["parts"][0] == {
        "type": "tool_result",
        "name": "lookup_population",
        "id": "call_berlin",
        "result": {"city": "Berlin", "population": 3877100},
    }


def test_repeated_instructions_are_only_included_when_they_change():
    trace = [
        {"kind": "request", "instructions": "First.", "parts": []},
        {"kind": "request", "instructions": "First.", "parts": []},
        {"kind": "request", "instructions": None, "parts": []},
        {"kind": "request", "instructions": "Second.", "parts": []},
    ]

    messages = compact_trajectory(parse_trace(trace), name="trace.json")["messages"]

    assert isinstance(messages, list)
    assert [message.get("instructions") for message in messages] == [
        "First.",
        None,
        None,
        "Second.",
    ]


def test_unknown_variants_and_invalid_tool_args_remain_inspectable():
    trace = [
        {"kind": "telepathy", "parts": [], "payload": "message"},
        {
            "kind": "response",
            "parts": [
                {
                    "part_kind": "tool-call",
                    "tool_name": "broken",
                    "tool_call_id": "call-1",
                    "args": "not json {",
                },
                {"part_kind": "future-part", "payload": {"value": 1}},
                {"future": True},
            ],
        },
    ]

    messages = compact_trajectory(parse_trace(trace), name="future.json")["messages"]

    assert isinstance(messages, list)
    assert messages[0] == {"type": "unknown", "data": trace[0]}
    assert messages[1]["parts"] == [
        {
            "type": "tool_call",
            "name": "broken",
            "id": "call-1",
            "args": "not json {",
        },
        {"type": "unknown", "original_type": "future-part", "data": {"payload": {"value": 1}}},
        {"type": "unknown", "original_type": "unknown", "data": {"future": True}},
    ]


def test_binary_payloads_are_replaced_with_metadata():
    trace = [
        {
            "kind": "request",
            "parts": [
                {
                    "part_kind": "user-prompt",
                    "content": [
                        "Read this.",
                        {"kind": "binary", "media_type": "text/plain", "data": "aGVsbG8="},
                        {"kind": "image-url", "url": "https://example.test/image.png"},
                    ],
                }
            ],
        },
        {
            "kind": "request",
            "parts": [
                {
                    "part_kind": "tool-return",
                    "tool_name": "read",
                    "tool_call_id": "call-1",
                    "content": {
                        "nested": {
                            "kind": "binary",
                            "media_type": "text/plain",
                            "data": "aGVsbG8=",
                        }
                    },
                }
            ],
        },
    ]

    messages = compact_trajectory(parse_trace(trace), name="media.json")["messages"]

    assert isinstance(messages, list)
    assert messages[0]["parts"][0]["content"] == [
        "Read this.",
        {"type": "file", "media_type": "text/plain", "bytes": 5, "payload_omitted": True},
        {"type": "image", "url": "https://example.test/image.png"},
    ]
    assert messages[1]["parts"][0]["result"] == {
        "nested": {
            "type": "file",
            "media_type": "text/plain",
            "bytes": 5,
            "payload_omitted": True,
        }
    }


def test_tool_search_and_capability_parts_compact_to_their_payloads():
    raw = json.loads((FIXTURES / "runs" / "tool_search.json").read_text(encoding="utf-8"))

    messages = compact_trajectory(parse_trace(raw), name="tool_search.json")["messages"]

    assert isinstance(messages, list)
    assert messages[1]["parts"][1] == {
        "type": "tool_call",
        "name": "search_tools",
        "args": {"queries": ["refund invoice", "billing charge lookup"]},
        "id": "search_1",
        "tool_kind": "tool-search",
    }
    # Per-match objects are unwrapped to the names they carry.
    assert messages[2]["parts"][0] == {
        "type": "tool_result",
        "name": "search_tools",
        "result": {"discovered_tools": ["refund_invoice", "get_invoice", "list_charges"]},
        "id": "search_1",
        "outcome": "success",
        "tool_kind": "tool-search",
    }
    assert messages[2]["parts"][1] == {
        "type": "tools_available",
        "tools_added": ["refund_invoice", "get_invoice", "list_charges"],
        "id": "search_1",
    }
    assert messages[3]["parts"][0]["args"] == {"id": "billing"}
    assert messages[4]["parts"][0]["result"]["instructions"].startswith("**Billing capability**")
    empty_search = messages[5]["parts"][1]
    assert empty_search["builtin"] is True
    assert empty_search["result"] == {
        "discovered_tools": [],
        "message": "No matching tools found. The tools you need may not be available.",
    }


def test_tool_availability_delta_accepts_the_legacy_added_alias():
    trace = [
        {
            "kind": "request",
            "parts": [{"part_kind": "tool-availability-delta", "added": ["a", "b"]}],
        }
    ]

    messages = compact_trajectory(parse_trace(trace), name="delta.json")["messages"]

    assert isinstance(messages, list)
    assert messages[0]["parts"] == [{"type": "tools_available", "tools_added": ["a", "b"]}]


def test_a_tool_return_only_unwraps_matches_when_its_tool_kind_says_so():
    """Discrimination follows `tool_kind`, so a user tool of the same name is left alone."""
    trace = [
        {
            "kind": "request",
            "parts": [
                {
                    "part_kind": "tool-return",
                    "tool_name": "search_tools",
                    "tool_call_id": "c1",
                    "content": {"discovered_tools": [{"name": "a", "score": 1}]},
                }
            ],
        }
    ]

    messages = compact_trajectory(parse_trace(trace), name="lookalike.json")["messages"]

    assert isinstance(messages, list)
    assert messages[0]["parts"][0]["result"] == {"discovered_tools": [{"name": "a", "score": 1}]}
