"""`paitrace stats`: one summary row per trace, with its runs, as a table or as JSONL.

The numbers are the same totals the viewer and `paitrace json` show. A run's numbers
are its own, without the runs it started, so they can be summed by run name across
traces without counting a subagent twice.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from typing import Literal

from ._format import display_width, format_count, format_duration, format_usd, ljust, rjust
from ._json import dumps_readable
from .analysis import Totals, analyze, combine_totals
from .compact import compact_totals
from .load import NotATraceError, TraceLoadError, load_trajectory
from .scan import jsonl_lines
from .trajectory import RunId, Trajectory


@dataclass(frozen=True)
class RunStats:
    id: RunId
    name: str
    parent_id: RunId | None
    depth: int  # 0 for a top-level run
    totals: Totals  # this run only


@dataclass(frozen=True)
class TraceStats:
    name: str
    runs: tuple[RunStats, ...]  # in tree order
    totals: Totals


@dataclass(frozen=True)
class InvalidTrace:
    name: str
    error: str


type StatsRow = TraceStats | InvalidTrace


def source_rows(
    chunks: Iterable[str],
    *,
    format: Literal["json", "jsonl"],
    name: str,
    skip_non_trace: bool = False,
) -> Iterator[StatsRow]:
    """One row per trace in a source; an empty JSONL source is one invalid row.

    `chunks` is the source text, whole or streamed line by line from a file. With
    `skip_non_trace`, a source whose first trace is not a trace at all, such as a
    `package.json` found in a directory, yields no rows.
    """
    traces = (
        iter([("".join(chunks), name)])
        if format == "json"
        else ((text, f"{name} · trace {n}") for n, text in enumerate(jsonl_lines(chunks), 1))
    )
    count = 0
    for count, (text, trace_name) in enumerate(traces, start=1):
        try:
            trajectory = load_trajectory(text, name=trace_name)
        except TraceLoadError as exc:
            if skip_non_trace and count == 1 and isinstance(exc, NotATraceError):
                return
            yield InvalidTrace(name=trace_name, error=str(exc))
        else:
            yield _trace_stats(trajectory, name=trace_name)
    if count == 0:
        yield InvalidTrace(name=name, error="contains no traces")


def _trace_stats(trajectory: Trajectory, *, name: str) -> TraceStats:
    analysis = analyze(trajectory)
    own = {run.run_id: run.totals for run in analysis.runs}
    runs = tuple(
        RunStats(
            id=run.id,
            name=run.name,
            parent_id=run.parent.run_id if run.parent else None,
            depth=depth,
            totals=own[run.id],
        )
        for run, depth in trajectory.walk()
    )
    return TraceStats(name=name, runs=runs, totals=analysis.totals)


def format_table(rows: Sequence[StatsRow]) -> str:
    """Aligned columns, then invalid traces.

    A trace with several runs is followed by one indented row per run. Several traces
    get a totals row.
    """
    valid = [row for row in rows if isinstance(row, TraceStats)]
    invalid = [row for row in rows if isinstance(row, InvalidTrace)]
    lines: list[str] = []
    if valid:
        body: list[tuple[str, ...]] = []
        for row in valid:
            body.append(_cells(row.name, format_count(len(row.runs)), row.totals))
            if len(row.runs) > 1:
                body.extend(
                    _cells("  " * (run.depth + 1) + run.name, "", run.totals) for run in row.runs
                )
        if len(valid) > 1:
            # Traces are unrelated, so their wall times add up rather than overlap.
            total = combine_totals(
                (row.totals for row in valid),
                sum(row.totals.duration_seconds for row in valid),
            )
            body.append(_cells("total", format_count(sum(len(row.runs) for row in valid)), total))
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
    """One object per trace: `{name, stats, runs}`, or `{name, error}` when it is invalid.

    Each run is `{id, name, parent, stats}` with its own stats, in tree order.
    """
    documents = (
        {
            "name": row.name,
            "stats": compact_totals(row.totals),
            "runs": [
                {
                    "id": run.id,
                    "name": run.name,
                    "parent": run.parent_id,
                    "stats": compact_totals(run.totals),
                }
                for run in row.runs
            ],
        }
        if isinstance(row, TraceStats)
        else {"name": row.name, "error": row.error}
        for row in rows
    )
    return "".join(dumps_readable(document) + "\n" for document in documents)


_HEADER = ("trace", "runs", "calls", "in", "cached", "out", "cost", "wall")


def _cells(name: str, runs: str, totals: Totals) -> tuple[str, ...]:
    tokens = totals.tokens
    return (
        name,
        runs,
        format_count(totals.llm_calls),
        format_count(tokens.input),
        format_count(tokens.cache_read),
        format_count(tokens.output),
        _cost(totals),
        format_duration(totals.duration_seconds),
    )


def _cost(totals: Totals) -> str:
    if totals.cost_usd is None:
        return "-"
    return format_usd(totals.cost_usd) + ("*" if totals.unpriced_calls else "")


def _align(rows: list[tuple[str, ...]]) -> list[str]:
    """Left-align the name column and right-align the numbers."""
    widths = [max(display_width(row[i]) for row in rows) for i in range(len(rows[0]))]
    return [
        "  ".join(
            ljust(cell, width) if i == 0 else rjust(cell, width)
            for i, (cell, width) in enumerate(zip(row, widths, strict=True))
        ).rstrip()
        for row in rows
    ]
