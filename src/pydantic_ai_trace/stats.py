"""`paitrace stats`: one summary row per trace, as a table or as JSONL.

The numbers are the same totals the viewer and `paitrace json` show.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .analysis import Totals, analyze, combine_totals
from .compact import compact_totals
from .load import TraceLoadError, load_trajectory
from .text import format_usd


@dataclass(frozen=True)
class TraceStats:
    name: str
    runs: int
    totals: Totals


@dataclass(frozen=True)
class InvalidTrace:
    name: str
    error: str


type StatsRow = TraceStats | InvalidTrace


def stats_row(text: str, *, name: str) -> StatsRow:
    try:
        trajectory = load_trajectory(text, name=name)
    except TraceLoadError as exc:
        return InvalidTrace(name=name, error=str(exc))
    return TraceStats(name=name, runs=len(trajectory.runs), totals=analyze(trajectory).totals)


def format_table(rows: Sequence[StatsRow]) -> str:
    """Aligned columns, a totals row when there are several traces, then invalid traces."""
    valid = [row for row in rows if isinstance(row, TraceStats)]
    invalid = [row for row in rows if isinstance(row, InvalidTrace)]
    lines: list[str] = []
    if valid:
        body = [_cells(row.name, row.runs, row.totals) for row in valid]
        if len(valid) > 1:
            # Traces are unrelated, so their wall times add up rather than overlap.
            total = combine_totals(
                (row.totals for row in valid),
                sum(row.totals.duration_seconds for row in valid),
            )
            body.append(_cells("total", sum(row.runs for row in valid), total))
        lines.extend(_align([_HEADER, *body]))
        if any(row.totals.unpriced_calls for row in valid):
            lines.append("* includes responses without a known price")
    if invalid:
        if lines:
            lines.append("")
        lines.append(f"{len(invalid)} invalid:")
        lines.extend(f"  {row.name}: {row.error}" for row in invalid)
    return "\n".join(lines) + "\n" if lines else ""


def format_jsonl(rows: Iterable[StatsRow]) -> str:
    """One object per trace: `{name, runs, stats}`, or `{name, error}` when it is invalid."""
    documents = (
        {"name": row.name, "runs": row.runs, "stats": compact_totals(row.totals)}
        if isinstance(row, TraceStats)
        else {"name": row.name, "error": row.error}
        for row in rows
    )
    return "".join(json.dumps(document, ensure_ascii=False) + "\n" for document in documents)


_HEADER = ("trace", "runs", "calls", "in", "cached", "out", "cost", "wall")


def _cells(name: str, runs: int, totals: Totals) -> tuple[str, ...]:
    tokens = totals.tokens
    return (
        name,
        str(runs),
        str(totals.llm_calls),
        str(tokens.input),
        str(tokens.cache_read),
        str(tokens.output),
        _cost(totals),
        f"{totals.duration_seconds:.1f}s",
    )


def _cost(totals: Totals) -> str:
    if totals.cost_usd is None:
        return "-"
    return format_usd(totals.cost_usd) + ("*" if totals.unpriced_calls else "")


def _align(rows: list[tuple[str, ...]]) -> list[str]:
    """Left-align the name column and right-align the numbers."""
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return [
        "  ".join(
            cell.ljust(width) if i == 0 else cell.rjust(width)
            for i, (cell, width) in enumerate(zip(row, widths, strict=True))
        ).rstrip()
        for row in rows
    ]
