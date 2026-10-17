"""Filesystem scanning: trace discovery, jsonl splitting, and path safety.

Reading and selecting only checks that each trace is a JSON array or object;
`load.load_trajectory` owns validation. Tree nodes run that validation on every
trace, so the sidebar can explain why a trace cannot be opened and can label and
filter traces by a short summary.
A directory scan leaves out JSON that is not a trace at all, such as `package.json`;
a file named explicitly keeps its node and says why it is not a trace.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic_ai.messages import ModelResponse, TextContent, UserPromptPart

from .load import NotATraceError, TraceLoadError, load_trajectory
from .trajectory import Trajectory

TRACE_SUFFIXES: dict[str, Literal["json", "jsonl"]] = {".json": "json", ".jsonl": "jsonl"}

# Bounds a trace summary's text, so the tree stays small for large logs; the sidebar
# shows less than this and filters on exactly this much.
PREVIEW_CHARS = 200

# Directories a scan never enters, whatever git says: a .gitignore may not list them.
# Hidden entries, such as `.git`, `.venv`, and `.pixi`, are skipped by name already.
SKIPPED_DIRS = frozenset({"node_modules", "venv", "__pycache__", "dist", "build"})

type TreeNode = dict[str, Any]
type TraceSummary = dict[str, Any]


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


class LineSelectionError(TraceLookupError):
    """A JSONL source needs a line, or has no trace at the requested one."""

    def __init__(self, name: str, count: int) -> None:
        super().__init__(f"{name!r} has {count} traces; pass line 1..{count}", status_code=400)
        self.name = name
        self.count = count


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


def build_tree(root: Path, *, ignored: frozenset[Path] = frozenset()) -> TreeNode:
    """Build the trace tree for a root directory or a single trace file.

    The scan skips hidden entries, `SKIPPED_DIRS`, and the `ignored` paths, as
    from `git_ignored(root)`. Directories without any trace files underneath are
    pruned, and so is JSON that is not a trace. Broken or unreadable traces are
    kept with a concise diagnostic, so the viewer can explain why a trace cannot
    be opened.
    """
    if root.is_file():
        return _file_node(root, root.name)[0]
    return _dir_node(root, root, name=root.name, ignored=ignored)


def git_ignored(root: Path) -> frozenset[Path]:
    """Untracked paths under directory `root` that git ignores, joined to `root`.

    An ignored directory is listed once, not its contents. Empty when `root` is
    not a directory in a git work tree, when git is unavailable, and when `root`
    itself is ignored: naming an ignored directory is a request to read it.
    """
    if not root.is_dir():
        return frozenset()
    command = ["git", "-C", str(root), "ls-files", "-z", "--others", "--ignored"]
    command += ["--exclude-standard", "--directory"]
    try:
        result = subprocess.run(command, capture_output=True, check=False)
    except OSError:
        return frozenset()
    paths = [os.fsdecode(path) for path in result.stdout.split(b"\0") if path]
    if result.returncode != 0 or "./" in paths:
        return frozenset()
    return frozenset(root / path.removesuffix("/") for path in paths)


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
        parent["children"].append(_file_node(selected.path, selected.key)[0])
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
        if TRACE_SUFFIXES[path.suffix] == "json":
            return select_trace(
                path.read_text(encoding="utf-8"), format="json", name=relative_path, line=line
            )
        # Stream JSONL: an evaluation log can be far larger than the one trace asked for.
        with path.open(encoding="utf-8") as lines:
            return _select_jsonl(lines, name=relative_path, line=line)
    except (OSError, UnicodeDecodeError) as exc:
        raise TraceLookupError(f"cannot read {relative_path!r}: {exc}", status_code=400) from exc


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

    for _ in iter_jsonl_traces([text], name=name):
        pass


def iter_jsonl_traces(chunks: Iterable[str], *, name: str) -> Iterator[tuple[int, str]]:
    """Yield validated JSONL traces with one-based trace numbers."""
    trace_number = 0
    for trace_number, candidate in enumerate(jsonl_lines(chunks), start=1):
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

    return _select_jsonl([text], name=name, line=line)


def _select_jsonl(chunks: Iterable[str], *, name: str, line: int | None) -> str:
    """Select one JSONL trace, keeping only that trace in memory.

    Stops at the requested line; without one, counts every trace to tell a
    one-trace file from an ambiguous one.
    """
    count = 0
    selected: str | None = None
    for count, candidate in enumerate(jsonl_lines(chunks), start=1):
        if count == (1 if line is None else line):
            selected = candidate
            if line is not None:
                break
    if count == 0:
        raise TraceLookupError(f"{name!r} contains no traces", status_code=400)
    if selected is None or (line is None and count > 1):
        raise LineSelectionError(name, count)
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


def iter_trace_files(directory: Path, *, ignored: frozenset[Path] = frozenset()) -> Iterator[Path]:
    """Trace files under `directory`, in the sidebar's order and with its exclusions."""
    for entry in _visible_entries(directory, ignored):
        if entry.is_dir():
            yield from iter_trace_files(entry, ignored=ignored)
        elif entry.suffix in TRACE_SUFFIXES:
            yield entry


def jsonl_lines(chunks: Iterable[str]) -> Iterator[str]:
    """The non-empty lines of JSONL text or a streamed file, one trace each, unvalidated.

    Splits at `\\n` only: `str.splitlines` also splits at U+2028, which a JSON string
    may hold unescaped.
    """
    for chunk in chunks:
        for line in chunk.split("\n"):
            if line.strip():
                yield line.removesuffix("\r")


def _visible_entries(directory: Path, ignored: frozenset[Path]) -> list[Path]:
    """Directory entries a scan enters: directories first, then by name.

    Leaves out hidden entries, symlinks, `SKIPPED_DIRS`, and `ignored` paths.
    """
    try:
        entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except OSError:
        return []
    return [
        entry
        for entry in entries
        if not entry.name.startswith(".")
        and not entry.is_symlink()
        and not (entry.name in SKIPPED_DIRS and entry.is_dir())
        and entry not in ignored
    ]


def _dir_node(root: Path, directory: Path, name: str, ignored: frozenset[Path]) -> TreeNode:
    children: list[TreeNode] = []
    for entry in _visible_entries(directory, ignored):
        if entry.is_dir():
            child = _dir_node(root, entry, name=entry.name, ignored=ignored)
            if child["children"]:
                children.append(child)
        elif entry.suffix in TRACE_SUFFIXES:
            node, is_trace = _file_node(entry, entry.relative_to(root).as_posix())
            if is_trace:
                children.append(node)
    return {
        "name": name,
        "path": directory.relative_to(root).as_posix(),
        "type": "dir",
        "children": children,
    }


def _file_node(path: Path, relative_path: str) -> tuple[TreeNode, bool]:
    """A file and a summary of each of its traces, and whether the file is a trace.

    The file itself is an error when it cannot be read, holds no traces, or holds
    one invalid trace; an invalid trace among several is flagged on its summary only.
    A file whose first trace is not a trace at all is not a trace file.
    """
    node: TreeNode = {
        "name": path.name,
        "path": relative_path,
        "type": "file",
        "format": TRACE_SUFFIXES[path.suffix],
        "trace_count": 0,
        "error": False,
        "traces": [],
    }
    try:
        if path.suffix == ".json":
            trajectory = _load(path.read_text(encoding="utf-8"), relative_path)
            traces = [_trace_summary(1, trajectory)]
            is_trace = not isinstance(trajectory, NotATraceError)
        else:
            traces, is_trace = [], True
            with path.open(encoding="utf-8") as stream:
                # Summarize while streaming, so only one trajectory is held at a time.
                for number, line in enumerate(jsonl_lines(stream), start=1):
                    trajectory = _load(line, relative_path)
                    if number == 1:
                        is_trace = not isinstance(trajectory, NotATraceError)
                    traces.append(_trace_summary(number, trajectory))
    except (OSError, UnicodeDecodeError) as exc:
        node["error"] = True
        node["error_message"] = f"cannot read file: {exc}"
        return node, True
    node["trace_count"] = len(traces)
    node["traces"] = traces
    if not traces:
        node["error"] = True
        node["error_message"] = "contains no traces"
    elif len(traces) == 1 and traces[0]["error"]:
        node["error"] = True
        message = traces[0]["error_message"]
        node["error_message"] = message if path.suffix == ".json" else f"line 1: {message}"
    return node, is_trace


def _load(text: str, relative_path: str) -> Trajectory | TraceLoadError:
    try:
        return load_trajectory(text, name=relative_path)
    except TraceLoadError as exc:
        return exc


def _trace_summary(line: int, trajectory: Trajectory | TraceLoadError) -> TraceSummary:
    """The 1-based `line` of a trace, previews of its first prompt and final answer,
    and its models; or its error."""
    if isinstance(trajectory, TraceLoadError):
        return {
            "line": line,
            "error": True,
            "error_message": str(trajectory),
            "prompt": None,
            "answer": None,
            "models": [],
        }
    return {
        "line": line,
        "error": False,
        "prompt": _first_prompt(trajectory),
        "answer": _final_answer(trajectory),
        "models": _model_names(trajectory),
    }


def _first_prompt(trajectory: Trajectory) -> str | None:
    """The first user prompt with text, in run-tree order."""
    for run, _ in trajectory.walk():
        for message in run.messages:
            for part in message.parts:
                if not isinstance(part, UserPromptPart):
                    continue
                items = [part.content] if isinstance(part.content, str) else part.content
                texts = [
                    item if isinstance(item, str) else item.content
                    for item in items
                    if isinstance(item, str | TextContent)
                ]
                if preview := _preview(" ".join(texts)):
                    return preview
    return None


def _final_answer(trajectory: Trajectory) -> str | None:
    """The text of the last response with text in the last top-level run."""
    for message in reversed(trajectory.roots()[-1].messages):
        if isinstance(message, ModelResponse) and (preview := _preview(message.text or "")):
            return preview
    return None


def _preview(text: str) -> str | None:
    """`text` whitespace-collapsed and truncated; None when blank."""
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) > PREVIEW_CHARS:
        return collapsed[: PREVIEW_CHARS - 1] + "…"
    return collapsed or None


def _model_names(trajectory: Trajectory) -> list[str]:
    """Distinct response model names, in order of first use."""
    names = (
        message.model_name
        for run in trajectory.runs
        for message in run.messages
        if isinstance(message, ModelResponse) and message.model_name
    )
    return list(dict.fromkeys(names))


def _sort_tree(node: TreeNode) -> None:
    children = node.get("children", [])
    children.sort(key=lambda child: (child["type"] != "dir", child["name"].lower()))
    for child in children:
        if child["type"] == "dir":
            _sort_tree(child)
