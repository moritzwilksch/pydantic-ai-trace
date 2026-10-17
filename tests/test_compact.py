import asyncio
import json
from pathlib import Path

import pytest
from pydantic_ai import Agent, capture_run_messages
from pydantic_ai.messages import (
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelResponse,
    ToolCallPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from traces import eval_set

from pydantic_ai_trace.compact import compact_payload
from pydantic_ai_trace.load import load_trajectory
from pydantic_ai_trace.payload import build_payload

FIXTURES = Path(__file__).parent / "fixtures"


def compact(trace: object, name: str) -> dict:
    """Compact a trace; a hand-written trace without timestamps gets a fixed one."""
    if isinstance(trace, list) and not any("timestamp" in message for message in trace):
        trace = [{"timestamp": "2026-01-01T09:00:00Z", **message} for message in trace]
    text = json.dumps(trace)
    return compact_payload(build_payload(load_trajectory(text, name=name), name=name))


def compact_messages(trace: object, name: str) -> list:
    return compact(trace, name)["runs"][0]["messages"]


def test_compact_trajectory_preserves_order_and_useful_fields():
    raw = json.loads((FIXTURES / "full_trace.json").read_text(encoding="utf-8"))

    document = compact(raw, "full_trace.json")

    assert document["name"] == "full_trace.json"
    assert document["stats"] == {
        "llm_calls": 3,
        "tokens": {"input": 930, "output": 165, "cache_write": 100},
        "cost_usd": 0.0028125,
        "wall_time_seconds": 6.0,
    }
    messages = document["runs"][0]["messages"]
    assert isinstance(messages, list)
    # Requests that only carried tool results are folded into their calls.
    assert [message["type"] for message in messages] == [
        "request",
        "response",
        "response",
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
    assert first_response["parts"][1:] == [
        {
            "type": "tool_call",
            "name": "lookup_population",
            "id": "call_berlin",
            "args": {"city": "Berlin"},
            "result": {"city": "Berlin", "population": 3877100},
        },
        {
            "type": "tool_call",
            "name": "lookup_population",
            "id": "call_hamburg",
            "args": {"city": "Hamburg"},
            "retry": "unknown city spelling",
        },
    ]


def test_tool_calls_carry_their_outcome_output_and_child_runs():
    document = compact(json.loads(eval_set().splitlines()[0]), "eval")

    support, researcher = document["runs"]  # tree order: parent first
    assert researcher["parent"] == {"run_id": "support", "tool_call_id": "c3"}
    calls = [
        part
        for message in support["messages"]
        for part in message["parts"]
        if part["type"] == "tool_call"
    ]
    assert [message["type"] for message in support["messages"]] == ["request"] + 3 * ["response"]
    assert calls[1] == {
        "type": "tool_call",
        "name": "fetch_policy",
        "args": {"topic": "refunds"},
        "id": "c2",
        "result": "timeout",
        "outcome": "failed",
    }
    assert calls[2]["child_runs"] == ["researcher"]
    # The output call's args are the output; its fixed acknowledgement is left out.
    assert calls[3] == {
        "type": "tool_call",
        "name": "final_result",
        "args": {"decision": "refund", "amount": 42.0},
        "id": "c4",
        "output": True,
    }


def test_a_result_without_a_call_stays_in_its_request():
    trace = [
        {
            "kind": "request",
            "parts": [
                {"part_kind": "tool-return", "tool_name": "t", "tool_call_id": "gone", "content": 1}
            ],
        }
    ]

    messages = compact_messages(trace, "orphan.json")

    assert messages[0]["parts"] == [{"type": "tool_result", "name": "t", "result": 1, "id": "gone"}]


def test_an_interrupted_request_keeps_its_state_after_its_results_fold():
    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(
            parts=[
                ToolCallPart(tool_name="ok", tool_call_id="a"),
                ToolCallPart(tool_name="boom", tool_call_id="b"),
            ]
        )

    agent = Agent(FunctionModel(model))

    @agent.tool_plain(sequential=True)
    def ok() -> str:
        return "fine"

    @agent.tool_plain(sequential=True)
    def boom() -> str:
        raise RuntimeError("broke")

    with capture_run_messages() as captured, pytest.raises(RuntimeError):
        asyncio.run(agent.run("go"))
    trace = json.loads(ModelMessagesTypeAdapter.dump_json(captured))

    messages = compact_messages(trace, "interrupted.json")

    assert messages[1]["parts"][0]["result"] == "fine"
    assert messages[2] == {"type": "request", "state": "interrupted", "parts": []}


def test_repeated_instructions_are_only_included_when_they_change():
    trace = [
        {"kind": "request", "instructions": "First.", "parts": []},
        {"kind": "request", "instructions": "First.", "parts": []},
        {"kind": "request", "instructions": None, "parts": []},
        {"kind": "request", "instructions": "Second.", "parts": []},
    ]

    messages = compact_messages(trace, "trace.json")

    assert isinstance(messages, list)
    assert [message.get("instructions") for message in messages] == [
        "First.",
        None,
        None,
        "Second.",
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

    messages = compact_messages(trace, "media.json")

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

    messages = compact_messages(raw, "tool_search.json")

    assert isinstance(messages, list)
    # Per-match objects are unwrapped to the names they carry.
    assert messages[1]["parts"][1] == {
        "type": "tool_call",
        "name": "search_tools",
        "args": {"queries": ["refund invoice", "billing charge lookup"]},
        "id": "search_1",
        "tool_kind": "tool-search",
        "result": {"discovered_tools": ["refund_invoice", "get_invoice", "list_charges"]},
    }
    assert messages[2]["parts"] == [
        {
            "type": "tools_available",
            "tools_added": ["refund_invoice", "get_invoice", "list_charges"],
            "id": "search_1",
        }
    ]
    assert messages[3]["parts"][0]["args"] == {"id": "billing"}
    assert messages[3]["parts"][0]["result"]["instructions"].startswith("**Billing capability**")
    empty_search = messages[5]["parts"][0]
    assert empty_search["builtin"] is True
    assert empty_search["result"] == {
        "discovered_tools": [],
        "message": "No matching tools found. The tools you need may not be available.",
    }


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

    messages = compact_messages(trace, "lookalike.json")

    assert isinstance(messages, list)
    assert messages[0]["parts"][0]["result"] == {"discovered_tools": [{"name": "a", "score": 1}]}


def test_tool_args_that_are_not_json_stay_strings():
    trace = [
        {
            "kind": "response",
            "parts": [
                {
                    "part_kind": "tool-call",
                    "tool_name": "broken",
                    "tool_call_id": "call-1",
                    "args": "not json {",
                }
            ],
        },
    ]

    messages = compact_messages(trace, "args.json")

    assert messages[0]["parts"] == [
        {"type": "tool_call", "name": "broken", "id": "call-1", "args": "not json {"}
    ]


def test_trajectory_runs_are_in_tree_order_with_their_tree_links():
    raw = json.loads((FIXTURES / "trajectory.json").read_text(encoding="utf-8"))

    document = compact(raw, "workflow")

    runs = document["runs"]
    assert [run["name"] for run in runs] == ["planner", "worker", "subagent", "summarizer"]
    assert runs[2]["parent"] == {"run_id": "worker", "tool_call_id": "call_1"}
    assert "parent" not in runs[0]
    assert runs[1]["outcome"] == {"status": "completed", "output": "result"}
    assert document["stats"]["llm_calls"] == 5
