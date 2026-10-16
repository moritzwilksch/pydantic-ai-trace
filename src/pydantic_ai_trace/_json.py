"""Parse JSON that serializes back unchanged: no `NaN`, no `Infinity`, no overflowing numbers.

Python's `json` module accepts all three and yields non-finite floats, which strict JSON
output (`allow_nan=False`) cannot write.
"""

from __future__ import annotations

import json
import math


def loads_finite(text: str) -> object:
    """`json.loads`, raising `ValueError` for non-finite numbers."""
    return json.loads(text, parse_float=_finite_float, parse_constant=_reject_constant)


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"number out of range: {text}")
    return value


def _reject_constant(text: str) -> None:
    raise ValueError(f"non-standard JSON constant {text!r}")
