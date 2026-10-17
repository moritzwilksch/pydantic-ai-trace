"""JSON helpers for untrusted trace text.

`loads_finite` rejects `NaN`, `Infinity`, and overflowing numbers, which Python's
`json` module accepts as non-finite floats that strict output cannot write.
`dumps_readable` keeps Unicode readable but escapes lone surrogates, which UTF-8
output cannot encode. `dumps_compact` is the one policy for JSON sent to the viewer.
"""

from __future__ import annotations

import json
import math
from typing import Any


def loads_finite(text: str) -> object:
    """`json.loads`, raising `ValueError` for non-finite numbers."""
    return json.loads(text, parse_float=_finite_float, parse_constant=_reject_constant)


def dumps_readable(value: object, **options: Any) -> str:
    """`json.dumps` with readable Unicode, safe to write as UTF-8."""
    rendered = json.dumps(value, ensure_ascii=False, **options)
    # A lone surrogate becomes the JSON escape `\\udXXX`, which decodes back to it.
    return rendered.encode("utf-8", errors="backslashreplace").decode("utf-8")


def dumps_compact(value: object) -> str:
    """Strict, compact `dumps_readable` for the viewer's payloads and API responses."""
    return dumps_readable(value, allow_nan=False, separators=(",", ":"))


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"number out of range: {text}")
    return value


def _reject_constant(text: str) -> None:
    raise ValueError(f"non-standard JSON constant {text!r}")
