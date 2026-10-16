"""Load trace text into a validated `Trajectory`.

A JSON array is a bare `list[ModelMessage]` dump and becomes a one-run trajectory.
A JSON object is a `Trajectory`. Loading is strict: anything else is an error.
"""

from __future__ import annotations

import json

from pydantic import ValidationError

from .trajectory import Run, RunId, Trajectory

SINGLE_RUN_ID = RunId("run")  # Deterministic, so a selected run survives live reload.


class TraceLoadError(ValueError):
    """Trace text is not a valid message list or trajectory."""


def load_trajectory(text: str, *, name: str) -> Trajectory:
    try:
        data = json.loads(text, parse_constant=_reject_constant)
    except (json.JSONDecodeError, ValueError) as exc:
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


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant {value!r}")
