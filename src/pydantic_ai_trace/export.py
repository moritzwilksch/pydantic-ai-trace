"""Compatibility wrappers for exporting traces to self-contained HTML files."""

from __future__ import annotations

from pathlib import Path

from . import scan
from ._html import inject_trace_data as _inject_trace_data
from ._html import packaged_index_html
from .text import format_trace_json_as_text
from .view import TraceView

__all__ = [
    "export_html",
    "inject_trace_data",
    "packaged_index_html",
    "write_export_html",
]


def export_html(trace_path: Path, output_path: Path, line: int | None) -> None:
    trace_json = scan.read_trace(trace_path.parent, trace_path.name, line)
    write_export_html(trace_json, output_path, trace_name=trace_path.name)


def write_export_html(trace_json: str, output_path: Path, *, trace_name: str) -> None:
    """Write HTML from an already-loaded trace, including stdin input."""
    TraceView.from_json(trace_json, title=trace_name).write(output_path)


def inject_trace_data(index_html: str, trace_json: str, trace_name: str) -> str:
    """Compatibility helper for injecting an already-loaded trace."""
    transcript = format_trace_json_as_text(trace_json, trace_name)
    return _inject_trace_data(
        index_html,
        trace_json,
        trace_name=trace_name,
        transcript=transcript,
    )
