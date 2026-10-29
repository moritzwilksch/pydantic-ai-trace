"""Internal helpers for composing the bundled viewer HTML.

The packaged `static/index.html` is a single-file Vite build (JS+CSS inlined).
A document injects its `TracePayload` before the bundle script, so the resulting file
renders offline from `file://`.
"""

from __future__ import annotations

import json
from importlib.resources import files

from .payload import TracePayload, build_payload
from .run_tree import RunTree

_INJECTION_MARKER = "<script"


def packaged_index_html() -> str:
    """The built frontend bundle; raises FileNotFoundError in a source checkout."""
    return (files("pydantic_ai_trace") / "static" / "index.html").read_text(encoding="utf-8")


def render_html(run_tree: RunTree, *, name: str = "trace") -> str:
    """A complete, self-contained HTML document that renders the run tree offline."""
    return payload_document(build_payload(run_tree, name=name))


def payload_document(payload: TracePayload) -> str:
    """Compose the self-contained document for one already-built payload."""
    return inject_payload(packaged_index_html(), payload.to_json())


def inject_payload(index_html: str, payload_json: str) -> str:
    """Insert the payload before the first script tag of the bundled viewer."""
    return _inject_before_bundle(
        index_html, f"<script>window.__TRACE_PAYLOAD__ = {_js_string(payload_json)};</script>"
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
