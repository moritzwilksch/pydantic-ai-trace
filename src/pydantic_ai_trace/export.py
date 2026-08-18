"""Export a trace as a self-contained HTML file.

The packaged `static/index.html` is a single-file Vite build (JS+CSS inlined).
Export injects the raw trace JSON and its preformatted text transcript before
the bundle script, so the resulting file renders offline from `file://`.
"""

from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

from . import scan
from .text import format_trace_json_as_text

_INJECTION_MARKER = "<script"


def export_html(trace_path: Path, output_path: Path, line: int | None) -> None:
    trace_json = scan.read_trace(trace_path.parent, trace_path.name, line)
    write_export_html(trace_json, output_path, trace_name=trace_path.name)


def write_export_html(trace_json: str, output_path: Path, *, trace_name: str) -> None:
    """Write HTML from an already-loaded trace, including stdin input."""
    output_path.write_text(
        inject_trace_data(packaged_index_html(), trace_json, trace_name=trace_name),
        encoding="utf-8",
    )


def packaged_index_html() -> str:
    """The built frontend bundle; raises FileNotFoundError in a source checkout."""
    return (files("pydantic_ai_trace") / "static" / "index.html").read_text(encoding="utf-8")


def inject_trace_data(index_html: str, trace_json: str, trace_name: str) -> str:
    """Insert the trace payload before the first script tag of the bundle."""
    marker_pos = index_html.find(_INJECTION_MARKER)
    if marker_pos == -1:
        raise ValueError("index.html has no <script> tag to inject before")
    # A literal `<` inside the JSON could end our script element early (`</`)
    # or shift the HTML parser into the script-data-escaped state (`<!--`,
    # `<script`); escaping to `\u003c` yields identical JSON with no `<` at all.
    transcript = format_trace_json_as_text(trace_json, trace_name)
    injection = (
        f"<script>window.__TRACE_DATA__ = {_js_string(trace_json)};"
        f"window.__TRACE_NAME__ = {_js_string(trace_name)};"
        f"window.__TRACE_TEXT__ = {_js_string(transcript)};</script>"
    )
    return index_html[:marker_pos] + injection + index_html[marker_pos:]


def _escape_lt(json_text: str) -> str:
    # In valid JSON, `<` only occurs inside strings, where `<` is equivalent.
    return json_text.replace("<", "\\u003c")


def _js_string(value: str) -> str:
    return _escape_lt(json.dumps(value))
