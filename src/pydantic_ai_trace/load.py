"""Load trace text into a validated `Trajectory`.

A JSON array is a bare `list[ModelMessage]` dump and becomes a one-run trajectory.
A JSON object is a `Trajectory`. Loading is strict: anything else is an error.

JSON that does not even have a trace's top-level shape raises `NotATraceError`, so
a directory scan can pass over a `package.json` while still reporting a trace that
fails validation.
"""

from __future__ import annotations

from typing import Any

import pydantic_ai
from pydantic import ValidationError

from ._json import loads_finite
from .trajectory import Run, RunId, Trajectory

SINGLE_RUN_ID = RunId("run")  # Deterministic, so a selected run survives live reload.


class TraceLoadError(ValueError):
    """Trace text is not a valid message list or trajectory.

    `str()` is a one-line summary. `details` lists every validation error, and is
    empty when the text failed before validation.
    """

    def __init__(self, message: str, details: tuple[str, ...] = ()) -> None:
        super().__init__(message)
        self.details = details


class NotATraceError(TraceLoadError):
    """Valid JSON whose top-level shape is neither a message list nor a trajectory."""


def load_trajectory(text: str, *, name: str) -> Trajectory:
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
            return Trajectory(runs=(Run.from_messages(data, name=name, id=SINGLE_RUN_ID),))
        return Trajectory.model_validate(data)
    except ValidationError as exc:
        raise _validation_error(exc, in_trajectory=isinstance(data, dict)) from exc
    except ValueError as exc:
        raise TraceLoadError(str(exc)) from exc


def _has_trace_shape(data: Any) -> bool:
    """Whether `data` claims to be a trace, valid or not.

    A trajectory is an object with `runs`. A message list is an array holding a
    message, which Pydantic AI discriminates by `kind`; an empty array is a message
    list without messages.
    """
    if isinstance(data, dict):
        return "runs" in data
    if isinstance(data, list):
        return not data or any(isinstance(item, dict) and "kind" in item for item in data)
    return False


def _validation_error(exc: ValidationError, *, in_trajectory: bool) -> TraceLoadError:
    """The first error as a summary, with an upgrade hint when one applies, and every
    error as a detail."""
    details = tuple(
        f"{'.'.join(str(part) for part in error['loc']) or '<root>'}: {error['msg']}"
        for error in exc.errors(include_url=False)
    )
    more = f" (+{exc.error_count() - 1} more)" if exc.error_count() > 1 else ""
    return TraceLoadError(
        details[0] + more + _upgrade_hint(exc, in_trajectory=in_trajectory), details
    )


def _upgrade_hint(exc: ValidationError, *, in_trajectory: bool) -> str:
    """Suggest an upgrade when a message or part kind is unknown, as a newer Pydantic AI writes.

    Unknown fields are ignored by Pydantic AI, so an unknown discriminator tag is the one
    failure that reliably points at a newer version.
    """
    for error in exc.errors(include_url=False):
        in_messages = not in_trajectory or error["loc"][2:3] == ("messages",)
        if error["type"] == "union_tag_invalid" and in_messages:
            tag = error.get("ctx", {}).get("tag")
            return (
                f"; Pydantic AI {pydantic_ai.__version__} does not know {tag!r}: "
                "if a newer Pydantic AI wrote this trace, upgrade pydantic-ai-slim"
            )
    return ""
