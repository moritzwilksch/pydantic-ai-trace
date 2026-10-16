"""Valid trace dumps for tests."""

from datetime import UTC, datetime, timedelta


def minimal_trace(content: str = "hello") -> str:
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
        ModelResponse(parts=[TextPart(content="ok")], timestamp=at + timedelta(seconds=1)),
    ]
    return ModelMessagesTypeAdapter.dump_json(messages).decode()
