"""Load trace text into a validated `Trajectory`.

A JSON array is a bare `list[ModelMessage]` dump and becomes a one-run trajectory.
A JSON object is a `Trajectory`. Loading is strict: anything else is an error.
"""

from __future__ import annotations

import pydantic_ai
from pydantic import ValidationError

from ._json import loads_finite
from .trajectory import Run, RunId, Trajectory

SINGLE_RUN_ID = RunId("run")  # Deterministic, so a selected run survives live reload.


class TraceLoadError(ValueError):
    """Trace text is not a valid message list or trajectory."""


def load_trajectory(text: str, *, name: str) -> Trajectory:
    try:
        data = loads_finite(text)
    except ValueError as exc:  # includes json.JSONDecodeError
        raise TraceLoadError(f"not valid JSON: {exc}") from exc
    try:
        if isinstance(data, list):
            return Trajectory(runs=(Run.from_messages(data, name=name, id=SINGLE_RUN_ID),))
        if isinstance(data, dict):
            return Trajectory.model_validate(data)
    except ValidationError as exc:
        raise TraceLoadError(
            _describe(exc) + _upgrade_hint(exc, in_trajectory=isinstance(data, dict))
        ) from exc
    except ValueError as exc:
        raise TraceLoadError(str(exc)) from exc
    raise TraceLoadError("expected a JSON array of messages or a trajectory object")


def _describe(exc: ValidationError) -> str:
    errors = exc.errors(include_url=False)
    first = errors[0]
    location = ".".join(str(part) for part in first["loc"]) or "<root>"
    more = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
    return f"{location}: {first['msg']}{more}"


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
