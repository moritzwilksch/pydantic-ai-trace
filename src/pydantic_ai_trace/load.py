"""Load trace text into a validated `RunTree`.

A JSON array is a bare `list[ModelMessage]` dump and becomes a one-run run tree.
A JSON object with `runs` is a `RunTree`, or a `RunCapture` when it also has the
capture's `id`, which a `RunTree` forbids; a capture is converted to a run tree.
Loading is strict: anything else is an error.

JSON that does not even have a trace's top-level shape raises `NotATraceError`, so
a directory scan can pass over a `package.json` while still reporting a trace that
fails validation.
"""

from __future__ import annotations

from typing import Any

import pydantic_ai
from pydantic import ValidationError

from ._json import loads_finite
from .run_capture import RunCapture
from .run_tree import Run, RunId, RunTree

SINGLE_RUN_ID = RunId("run")  # Deterministic, so a selected run survives live reload.


class TraceLoadError(ValueError):
    """Trace text is not a valid message list, run tree, or run capture.

    `str()` is a one-line summary. `details` lists every validation error, and is
    empty when the text failed before validation.
    """

    def __init__(self, message: str, details: tuple[str, ...] = ()) -> None:
        super().__init__(message)
        self.details = details


class NotATraceError(TraceLoadError):
    """Valid JSON whose top-level shape is neither a message list nor a run tree."""


def load_run_tree(text: str, *, name: str) -> RunTree:
    try:
        data = loads_finite(text)
    except ValueError as exc:  # includes json.JSONDecodeError
        raise TraceLoadError(f"not valid JSON: {exc}") from exc
    if not _has_trace_shape(data):
        raise NotATraceError(
            'not a trace: expected a list of Pydantic AI messages or an object with "runs"'
        )
    try:
        if isinstance(data, list):
            return RunTree(runs=(Run.from_messages(data, name=name, id=SINGLE_RUN_ID),))
        if isinstance(data, dict) and "id" in data:
            return RunCapture.model_validate(data).to_run_tree()
        return RunTree.model_validate(data)
    except ValidationError as exc:
        raise _validation_error(exc, in_runs=isinstance(data, dict)) from exc
    except ValueError as exc:
        raise TraceLoadError(str(exc)) from exc


def _has_trace_shape(data: Any) -> bool:
    """Whether `data` claims to be a trace, valid or not.

    A run tree or run capture is an object with `runs`. A message list is an array holding a
    message, which Pydantic AI discriminates by `kind`; an empty array is a message
    list without messages.
    """
    if isinstance(data, dict):
        return "runs" in data
    if isinstance(data, list):
        return not data or any(isinstance(item, dict) and "kind" in item for item in data)
    return False


def _validation_error(exc: ValidationError, *, in_runs: bool) -> TraceLoadError:
    """The first error as a summary, with an upgrade hint when one applies, and every
    error as a detail."""
    details = tuple(
        f"{'.'.join(str(part) for part in error['loc']) or '<root>'}: {error['msg']}"
        for error in exc.errors(include_url=False)
    )
    more = f" (+{exc.error_count() - 1} more)" if exc.error_count() > 1 else ""
    return TraceLoadError(details[0] + more + _upgrade_hint(exc, in_runs=in_runs), details)


def _upgrade_hint(exc: ValidationError, *, in_runs: bool) -> str:
    """Suggest an upgrade when a message or part kind is unknown, as a newer Pydantic AI writes.

    Unknown fields are ignored by Pydantic AI, so an unknown discriminator tag is the one
    failure that reliably points at a newer version.
    """
    for error in exc.errors(include_url=False):
        in_messages = not in_runs or error["loc"][2:3] == ("messages",)
        if error["type"] == "union_tag_invalid" and in_messages:
            tag = error.get("ctx", {}).get("tag")
            return (
                f"; Pydantic AI {pydantic_ai.__version__} does not know {tag!r}: "
                "if a newer Pydantic AI wrote this trace, upgrade pydantic-ai-slim"
            )
    return ""
