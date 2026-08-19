"""Internal helpers for composing the bundled viewer HTML."""

from __future__ import annotations

import json
from importlib.resources import files

_INJECTION_MARKER = "<script"


def packaged_index_html() -> str:
    """Read the built frontend bundle from the installed package."""
    return (files("pydantic_ai_trace") / "static" / "index.html").read_text(encoding="utf-8")


def inject_trace_data(
    index_html: str,
    trace_json: str,
    *,
    trace_name: str,
    transcript: str,
) -> str:
    """Insert one trace before the first script tag of the bundled viewer."""
    return _inject_before_bundle(
        index_html,
        (
            f"<script>window.__TRACE_DATA__ = {_js_string(trace_json)};"
            f"window.__TRACE_NAME__ = {_js_string(trace_name)};"
            f"window.__TRACE_TEXT__ = {_js_string(transcript)};</script>"
        ),
    )


def inject_trace_collection(index_html: str, collection_json: str) -> str:
    """Insert a named in-memory trace collection before the viewer bundle."""
    return _inject_before_bundle(
        index_html,
        f"<script>window.__TRACE_COLLECTION__ = {_js_string(collection_json)};</script>",
    )


def _inject_before_bundle(index_html: str, injection: str) -> str:
    marker_pos = index_html.find(_INJECTION_MARKER)
    if marker_pos == -1:
        raise ValueError("index.html has no <script> tag to inject before")
    return index_html[:marker_pos] + injection + index_html[marker_pos:]


def _escape_lt(json_text: str) -> str:
    # A literal `<` can close or change the parsing state of a script element.
    return json_text.replace("<", "\\u003c")


def _js_string(value: str) -> str:
    return _escape_lt(json.dumps(value))
