"""Public in-memory API for self-contained trace documents."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from importlib import import_module
from os import PathLike
from pathlib import Path
from typing import Self

from ._html import inject_trace_data, packaged_index_html
from .text import format_trace_json_as_text


@dataclass(frozen=True, init=False)
class TraceView:
    """An immutable, self-contained view of one Pydantic AI trace."""

    _trace_json: str = field(repr=False)
    title: str

    def __init__(self) -> None:
        raise TypeError("use TraceView.from_messages() or TraceView.from_json()")

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
        """Create a view from one serialized JSON trace."""
        if isinstance(trace_json, str):
            text = trace_json
        else:
            try:
                text = bytes(trace_json).decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError("trace JSON is not valid UTF-8") from exc

        try:
            parsed = json.loads(text, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"trace JSON is invalid: {exc}") from exc
        if not isinstance(parsed, list):
            raise ValueError("trace JSON must contain a top-level array of messages")

        view = object.__new__(cls)
        object.__setattr__(view, "_trace_json", text)
        object.__setattr__(view, "title", title)
        return view

    def html(self) -> str:
        """Return a complete, self-contained HTML document."""
        transcript = format_trace_json_as_text(self._trace_json, self.title)
        return inject_trace_data(
            packaged_index_html(),
            self._trace_json,
            trace_name=self.title,
            transcript=transcript,
        )

    def write(self, path: str | PathLike[str]) -> None:
        """Write the self-contained document as UTF-8."""
        Path(path).write_text(self.html(), encoding="utf-8")


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant {value!r}")
