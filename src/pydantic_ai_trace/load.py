"""Load trace text into a validated `Trajectory`.

A JSON array is a bare `list[ModelMessage]` dump and becomes a one-run trajectory.
A JSON object is a `Trajectory`. Loading is strict: anything else is an error.
"""

from __future__ import annotations

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
        raise TraceLoadError(_describe(exc)) from exc
    except ValueError as exc:
        raise TraceLoadError(str(exc)) from exc
    raise TraceLoadError("expected a JSON array of messages or a trajectory object")


def _describe(exc: ValidationError) -> str:
    errors = exc.errors(include_url=False)
    first = errors[0]
    location = ".".join(str(part) for part in first["loc"]) or "<root>"
    more = f" (+{len(errors) - 1} more)" if len(errors) > 1 else ""
    return f"{location}: {first['msg']}{more}"
