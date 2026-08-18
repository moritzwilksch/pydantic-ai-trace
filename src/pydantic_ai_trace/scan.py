"""Filesystem scanning: trace discovery, jsonl splitting, and path safety.

Traces are never validated against the pydantic-ai schema here — a trace file's
bytes are the payload and the frontend interprets them. "Parseable" only means
the file contains JSON array(s) at the expected granularity.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

TRACE_SUFFIXES: dict[str, Literal["json", "jsonl"]] = {".json": "json", ".jsonl": "jsonl"}

type TreeNode = dict[str, Any]


class TraceLookupError(Exception):
    """A requested trace path or line cannot be served."""

    def __init__(self, message: str, status_code: Literal[400, 404]) -> None:
        super().__init__(message)
        self.status_code = status_code


def resolve_within(root: Path, relative_path: str) -> Path:
    """Resolve `relative_path` against `root`, rejecting anything that escapes it."""
    if not relative_path or Path(relative_path).is_absolute():
        raise TraceLookupError(f"invalid path: {relative_path!r}", status_code=400)
    try:
        resolved = (root / relative_path).resolve()
    except (OSError, ValueError) as exc:  # e.g. embedded NUL byte
        raise TraceLookupError(f"invalid path: {relative_path!r}", status_code=400) from exc
    if not resolved.is_relative_to(root.resolve()):
        raise TraceLookupError(f"path escapes root: {relative_path!r}", status_code=400)
    return resolved


def build_tree(root: Path) -> TreeNode:
    """Build the trace tree for a root directory or a single trace file.

    Directories without any trace files underneath are pruned. Files that are
    unreadable or not valid JSON array(s) are kept with a concise diagnostic,
    so the viewer can explain why a trace cannot be opened.
    """
    if root.is_file():
        return _file_node(root, root.name)
    return _dir_node(root, root, name=root.name)


def read_trace(root: Path, relative_path: str, line: int | None) -> str:
    """Return the raw JSON text of one trace.

    For `.jsonl` files `line` is 1-based and required when the file has more
    than one trace. The returned string is the file's own bytes, unmodified.
    """
    path = resolve_within(root, relative_path)
    if not path.is_file() or path.suffix not in TRACE_SUFFIXES:
        raise TraceLookupError(f"no such trace: {relative_path!r}", status_code=404)

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise TraceLookupError(f"cannot read {relative_path!r}: {exc}", status_code=400) from exc

    return select_trace(
        text,
        format=TRACE_SUFFIXES[path.suffix],
        name=relative_path,
        line=line,
    )


def detect_trace_format(text: str) -> Literal["json", "jsonl"]:
    """Detect a complete JSON trace before falling back to JSONL."""
    try:
        json.loads(text)
    except json.JSONDecodeError:
        return "jsonl"
    return "json"


def validate_trace_data(
    text: str,
    *,
    format: Literal["json", "jsonl"],
    name: str,
) -> None:
    """Validate in-memory trace data without applying JSONL line selection."""
    if format == "json":
        _ensure_json_array(text, name)
        return

    lines = _jsonl_lines(text)
    if not lines:
        raise TraceLookupError(f"{name!r} contains no traces", status_code=400)
    for line_number, candidate in enumerate(lines, start=1):
        try:
            _ensure_json_array(candidate, name)
        except TraceLookupError as exc:
            raise TraceLookupError(f"line {line_number}: {exc}", status_code=400) from exc


def select_trace(
    text: str,
    *,
    format: Literal["json", "jsonl"],
    name: str,
    line: int | None,
) -> str:
    """Select one trace from validated JSON or JSONL text."""
    if format == "json":
        _ensure_json_array(text, name)
        return text

    lines = _jsonl_lines(text)
    if not lines:
        raise TraceLookupError(f"{name!r} contains no traces", status_code=400)
    index = 1 if line is None and len(lines) == 1 else line
    if index is None or not 1 <= index <= len(lines):
        raise TraceLookupError(
            f"{name!r} has {len(lines)} traces; pass line 1..{len(lines)}",
            status_code=400,
        )
    selected = lines[index - 1]
    _ensure_json_array(selected, name)
    return selected


def _ensure_json_array(text: str, relative_path: str) -> None:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TraceLookupError(f"{relative_path!r} is not valid JSON: {exc}", 400) from exc
    if not isinstance(parsed, list):
        raise TraceLookupError(f"{relative_path!r} is not a JSON array of messages", 400)


def _jsonl_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip()]


def _dir_node(root: Path, directory: Path, name: str) -> TreeNode:
    children: list[TreeNode] = []
    try:
        entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError:
        entries = []
    for entry in entries:
        if entry.name.startswith(".") or entry.is_symlink():
            continue
        if entry.is_dir():
            child = _dir_node(root, entry, name=entry.name)
            if child["children"]:
                children.append(child)
        elif entry.suffix in TRACE_SUFFIXES:
            children.append(_file_node(entry, entry.relative_to(root).as_posix()))
    return {
        "name": name,
        "path": directory.relative_to(root).as_posix(),
        "type": "dir",
        "children": children,
    }


def _file_node(path: Path, relative_path: str) -> TreeNode:
    node: TreeNode = {
        "name": path.name,
        "path": relative_path,
        "type": "file",
        "format": TRACE_SUFFIXES[path.suffix],
        "trace_count": 0,
        "error": False,
    }
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        node["error"] = True
        node["error_message"] = f"cannot read file: {exc}"
        return node

    if path.suffix == ".json":
        node["trace_count"] = 1
        error = _json_array_error(text, relative_path)
    else:
        lines = _jsonl_lines(text)
        node["trace_count"] = len(lines)
        if not lines:
            error = "contains no traces"
        else:
            error = next(
                (
                    f"line {line_number}: {line_error}"
                    for line_number, line in enumerate(lines, start=1)
                    if (line_error := _json_array_error(line, relative_path)) is not None
                ),
                None,
            )
    if error is not None:
        node["error"] = True
        node["error_message"] = error
    return node


def _is_json_array(text: str) -> bool:
    return _json_array_error(text, "") is None


def _json_array_error(text: str, relative_path: str) -> str | None:
    try:
        _ensure_json_array(text, relative_path)
    except TraceLookupError as exc:
        return str(exc)
    return None
