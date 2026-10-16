"""Filesystem scanning: trace discovery, jsonl splitting, and path safety.

Reading and selecting only checks that each trace is a JSON array or object;
`load.load_trajectory` owns validation. Tree nodes run that validation so the
sidebar can explain why a trace cannot be opened. For a JSONL file they validate
only the first trace, so a large log stays cheap to list; an error in a later
trace is reported when that trace is opened.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .load import TraceLoadError, load_trajectory

TRACE_SUFFIXES: dict[str, Literal["json", "jsonl"]] = {".json": "json", ".jsonl": "jsonl"}

type TreeNode = dict[str, Any]


@dataclass(frozen=True)
class CollectionFile:
    key: str
    path: Path


@dataclass(frozen=True)
class TraceCollection:
    root: Path
    files: tuple[CollectionFile, ...]

    @classmethod
    def from_paths(cls, paths: list[Path]) -> TraceCollection:
        """Build an allowlisted collection from distinct trace files."""
        if len(paths) < 2:
            raise ValueError("a trace collection requires at least two files")
        resolved = tuple(path.resolve() for path in paths)
        if len(set(resolved)) != len(resolved):
            raise ValueError("duplicate trace file paths are not allowed")
        for path in resolved:
            if not path.is_file() or path.suffix not in TRACE_SUFFIXES:
                raise ValueError(f"not a trace file (expected .json or .jsonl): {path}")
        try:
            root = Path(os.path.commonpath([str(path.parent) for path in resolved]))
        except ValueError as exc:
            raise ValueError("trace files must share a filesystem root") from exc
        files = tuple(CollectionFile(path.relative_to(root).as_posix(), path) for path in resolved)
        return cls(root=root, files=files)


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


def build_collection_tree(collection: TraceCollection) -> TreeNode:
    """Build a virtual tree containing only explicitly selected files."""
    root: TreeNode = {
        "name": "selected traces",
        "path": ".",
        "type": "dir",
        "children": [],
    }
    directories: dict[str, TreeNode] = {".": root}
    for selected in sorted(collection.files, key=lambda item: item.key.lower()):
        parent = root
        parts = Path(selected.key).parts
        prefixes: list[str] = []
        for part in parts[:-1]:
            prefixes.append(part)
            key = Path(*prefixes).as_posix()
            child = directories.get(key)
            if child is None:
                child = {"name": part, "path": key, "type": "dir", "children": []}
                parent["children"].append(child)
                directories[key] = child
            parent = child
        parent["children"].append(_file_node(selected.path, selected.key))
    _sort_tree(root)
    return root


def read_collection_trace(
    collection: TraceCollection,
    relative_path: str,
    line: int | None,
) -> str:
    """Read one allowlisted collection file without exposing siblings."""
    if relative_path not in {selected.key for selected in collection.files}:
        raise TraceLookupError(f"no such trace: {relative_path!r}", status_code=404)
    return read_trace(collection.root, relative_path, line)


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
        _ensure_json_container(text, name)
        return

    for _ in iter_jsonl_traces(text.splitlines(), name=name):
        pass


def iter_jsonl_traces(lines: Iterable[str], *, name: str) -> Iterator[tuple[int, str]]:
    """Yield validated non-empty JSONL traces with one-based trace numbers."""
    trace_number = 0
    for candidate in lines:
        if not candidate.strip():
            continue
        trace_number += 1
        try:
            _ensure_json_container(candidate, name)
        except TraceLookupError as exc:
            raise TraceLookupError(f"line {trace_number}: {exc}", status_code=400) from exc
        yield trace_number, candidate
    if trace_number == 0:
        raise TraceLookupError(f"{name!r} contains no traces", status_code=400)


def select_trace(
    text: str,
    *,
    format: Literal["json", "jsonl"],
    name: str,
    line: int | None,
) -> str:
    """Select one trace from validated JSON or JSONL text."""
    if format == "json":
        _ensure_json_container(text, name)
        return text

    lines = jsonl_traces(text)
    if not lines:
        raise TraceLookupError(f"{name!r} contains no traces", status_code=400)
    index = 1 if line is None and len(lines) == 1 else line
    if index is None or not 1 <= index <= len(lines):
        raise TraceLookupError(
            f"{name!r} has {len(lines)} traces; pass line 1..{len(lines)}",
            status_code=400,
        )
    selected = lines[index - 1]
    _ensure_json_container(selected, name)
    return selected


def _ensure_json_container(text: str, relative_path: str) -> None:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TraceLookupError(f"{relative_path!r} is not valid JSON: {exc}", 400) from exc
    if not isinstance(parsed, list | dict):
        raise TraceLookupError(
            f"{relative_path!r} is not a JSON array of messages or a trajectory object", 400
        )


def iter_trace_files(directory: Path) -> Iterator[Path]:
    """Trace files under `directory`, in the sidebar's order and with its exclusions."""
    for entry in _visible_entries(directory):
        if entry.is_dir():
            yield from iter_trace_files(entry)
        elif entry.suffix in TRACE_SUFFIXES:
            yield entry


def jsonl_traces(text: str) -> list[str]:
    """The non-empty lines of JSONL text, one trace each, unvalidated."""
    return list(_jsonl_lines([text]))


def _jsonl_lines(chunks: Iterable[str]) -> Iterator[str]:
    """Non-empty lines split as `str.splitlines` does, also when `chunks` streams a file."""
    for chunk in chunks:
        for line in chunk.splitlines():
            if line.strip():
                yield line


def _visible_entries(directory: Path) -> list[Path]:
    """Directory entries without hidden files or symlinks: directories first, then by name."""
    try:
        entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError:
        return []
    return [entry for entry in entries if not entry.name.startswith(".") and not entry.is_symlink()]


def _dir_node(root: Path, directory: Path, name: str) -> TreeNode:
    children: list[TreeNode] = []
    for entry in _visible_entries(directory):
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
        if path.suffix == ".json":
            node["trace_count"] = 1
            error = _trace_error(path.read_text(encoding="utf-8"), relative_path)
        else:
            node["trace_count"], error = _jsonl_summary(path, relative_path)
    except (OSError, UnicodeDecodeError) as exc:
        node["error"] = True
        node["error_message"] = f"cannot read file: {exc}"
        return node
    if error is not None:
        node["error"] = True
        node["error_message"] = error
    return node


def _jsonl_summary(path: Path, relative_path: str) -> tuple[int, str | None]:
    """Count a JSONL file's traces while streaming it, and validate only the first."""
    count = 0
    error: str | None = None
    with path.open(encoding="utf-8") as stream:
        for line in _jsonl_lines(stream):
            count += 1
            if count == 1 and (first_error := _trace_error(line, relative_path)) is not None:
                error = f"line 1: {first_error}"
    return count, error if count else "contains no traces"


def _sort_tree(node: TreeNode) -> None:
    children = node.get("children", [])
    children.sort(key=lambda child: (child["type"] != "dir", child["name"].lower()))
    for child in children:
        if child["type"] == "dir":
            _sort_tree(child)


def _trace_error(text: str, relative_path: str) -> str | None:
    try:
        load_trajectory(text, name=relative_path)
    except TraceLoadError as exc:
        return str(exc)
    return None
