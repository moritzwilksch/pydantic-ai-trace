"""Public in-memory API for self-contained trace documents."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from importlib import import_module
from typing import Self

from ._html import collection_document, trace_document
from .text import format_trace_json_as_text


@dataclass(frozen=True)
class TraceView:
    """An immutable, self-contained view of one Pydantic AI trace."""

    trace_json: str = field(repr=False)
    title: str = field(default="trace", kw_only=True)

    def __post_init__(self) -> None:
        try:
            parsed = json.loads(self.trace_json, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"trace JSON is invalid: {exc}") from exc
        if not isinstance(parsed, list):
            raise ValueError("trace JSON must contain a top-level array of messages")

    @classmethod
    def from_messages(
        cls,
        messages: Sequence[object],
        *,
        title: str = "trace",
    ) -> Self:
        """Create a view from Pydantic AI messages using its canonical adapter."""
        try:
            messages_module = import_module("pydantic_ai.messages")
        except ModuleNotFoundError as exc:
            if exc.name == "pydantic_ai" or (exc.name or "").startswith("pydantic_ai."):
                raise ImportError(
                    "TraceView.from_messages() requires pydantic-ai; "
                    "install pydantic-ai or pydantic-ai-slim"
                ) from exc
            raise

        try:
            adapter = messages_module.ModelMessagesTypeAdapter
        except AttributeError as exc:
            raise ImportError(
                "the installed pydantic-ai does not provide ModelMessagesTypeAdapter"
            ) from exc

        try:
            trace_json = adapter.dump_json(list(messages))
        except Exception as exc:
            raise ValueError("messages cannot be serialized as a Pydantic AI trace") from exc
        return cls.from_json(trace_json, title=title)

    @classmethod
    def from_json(
        cls,
        trace_json: str | bytes | bytearray,
        *,
        title: str = "trace",
    ) -> Self:
        """Create a view from one serialized JSON trace, decoding bytes as UTF-8."""
        if isinstance(trace_json, str):
            return cls(trace_json, title=title)
        try:
            text = bytes(trace_json).decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("trace JSON is not valid UTF-8") from exc
        return cls(text, title=title)

    def html(self) -> str:
        """Return a complete, self-contained HTML document."""
        return trace_document(self.trace_json, trace_name=self.title)

    def _embedded(self) -> dict[str, str]:
        """The payload shape the viewer expects for one trace inside a collection."""
        return {
            "name": self.title,
            "source": self.trace_json,
            "transcript": format_trace_json_as_text(self.trace_json, self.title),
        }


@dataclass(frozen=True)
class TraceCollectionView:
    """A self-contained view that selects between named in-memory traces."""

    traces: Sequence[TraceView]
    title: str = field(default="traces", kw_only=True)

    def __post_init__(self) -> None:
        object.__setattr__(self, "traces", tuple(self.traces))
        if not self.traces:
            raise ValueError("a trace collection requires at least one trace")
        if any(not isinstance(trace, TraceView) for trace in self.traces):
            raise TypeError("traces must contain only TraceView instances")
        names = [trace.title for trace in self.traces]
        if any(not name.strip() for name in names):
            raise ValueError("trace titles must not be empty")
        if len(set(names)) != len(names):
            raise ValueError("trace titles must be unique")

    def html(self) -> str:
        """Return a complete document with an in-memory trace sidebar."""
        return collection_document(
            json.dumps(
                {
                    "title": self.title,
                    "traces": [trace._embedded() for trace in self.traces],
                }
            )
        )


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant {value!r}")
