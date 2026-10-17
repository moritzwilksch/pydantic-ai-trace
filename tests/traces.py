"""Valid trace dumps for tests."""

from datetime import UTC, datetime, timedelta


def minimal_trace(content: str = "hello", model_name: str | None = None) -> str:
    """A one-line canonical dump: a prompt and its answer."""
    from pydantic_ai.messages import (
        ModelMessagesTypeAdapter,
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    at = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)
    messages = [
        ModelRequest(parts=[UserPromptPart(content=content, timestamp=at)]),
        ModelResponse(
            parts=[TextPart(content="ok")],
            model_name=model_name,
            timestamp=at + timedelta(seconds=1),
        ),
    ]
    return ModelMessagesTypeAdapter.dump_json(messages).decode()


def eval_set() -> str:
    """A three-trace JSONL eval set: a run tree with a failed subagent, a failed tool call,
    a retry, and an output tool; then two plain message lists."""
    from pydantic_ai.messages import (
        ModelMessagesTypeAdapter,
        ModelRequest,
        ModelResponse,
        RetryPromptPart,
        TextPart,
        ToolCallPart,
        ToolReturnPart,
        UserPromptPart,
    )
    from pydantic_ai.usage import RequestUsage

    from pydantic_ai_trace import Completed, Failed, Run, Trajectory
    from pydantic_ai_trace.trajectory import RunId

    at = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)
    usage = RequestUsage(input_tokens=100, output_tokens=20)

    def response(*parts, second: int) -> ModelResponse:
        return ModelResponse(
            parts=list(parts),
            usage=usage,
            model_name="gpt-4o",
            timestamp=at + timedelta(seconds=second),
        )

    def request(*parts) -> ModelRequest:
        return ModelRequest(parts=list(parts))

    decision = {"decision": "refund", "amount": 42.0}
    support = Run.from_messages(
        [
            request(UserPromptPart(content="Refund order A-1043?", timestamp=at)),
            response(
                ToolCallPart("lookup_order", {"order_id": "A-1043"}, tool_call_id="c1"),
                ToolCallPart("fetch_policy", {"topic": "refunds"}, tool_call_id="c2"),
                second=1,
            ),
            request(
                ToolReturnPart("lookup_order", {"status": "delivered"}, "c1", timestamp=at),
                ToolReturnPart("fetch_policy", "timeout", "c2", timestamp=at, outcome="failed"),
            ),
            response(ToolCallPart("ask_researcher", {"q": "refund rules"}, "c3"), second=2),
            request(ToolReturnPart("ask_researcher", "no answer", "c3", timestamp=at)),
            response(ToolCallPart("final_result", decision, tool_call_id="c4"), second=5),
            request(ToolReturnPart("final_result", "Final result processed.", "c4", timestamp=at)),
        ],
        name="support_agent",
        id=RunId("support"),
        outcome=Completed(output=decision),
    )
    researcher = Run.from_messages(
        [
            request(UserPromptPart(content="refund rules", timestamp=at + timedelta(seconds=3))),
            response(ToolCallPart("search", {"q": ""}, tool_call_id="s1"), second=3),
            request(
                RetryPromptPart(
                    "q must not be empty", tool_name="search", tool_call_id="s1", timestamp=at
                )
            ),
            response(TextPart("I could not search."), second=4),
        ],
        name="researcher",
        id=RunId("researcher"),
        outcome=Failed(error_type="UsageLimitExceeded", detail="request_limit of 2 exceeded"),
    ).child_of(support, tool_call_id="c3")

    def answer(prompt: str, text: str) -> str:
        messages = [
            request(UserPromptPart(content=prompt, timestamp=at)),
            response(TextPart(text), second=1),
        ]
        return ModelMessagesTypeAdapter.dump_json(messages).decode()

    return (
        "\n".join(
            [
                Trajectory(runs=(researcher, support)).model_dump_json(),
                answer("What is 2 + 2?", "4"),
                answer("Where is my refund?", "Refunds take five days."),
            ]
        )
        + "\n"
    )
