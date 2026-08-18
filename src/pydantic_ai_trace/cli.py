"""`paitrace` command line interface.

`paitrace PATH` serves a trace file or directory; `paitrace export` writes HTML;
and `paitrace text` or `paitrace json` writes a compact representation. Trace
commands accept paths or stdin. A command word is still treated as a path when a
file or directory with that name exists.
"""

from __future__ import annotations

import argparse
import contextlib
import sys
import tempfile
import threading
import webbrowser
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, TextIO

from . import __version__, scan

DEFAULT_PORT = 1205
DEFAULT_HOST = "127.0.0.1"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv and argv[0] == "export" and not Path("export").exists():
            return _run_export(argv[1:])
        if argv and argv[0] == "text" and not Path("text").exists():
            return _run_text(argv[1:])
        if argv and argv[0] == "json" and not Path("json").exists():
            return _run_json(argv[1:])
        return _run_serve(argv)
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


class CliError(Exception):
    pass


@dataclass(frozen=True)
class LoadedTrace:
    text: str
    name: str


class TextWriter(Protocol):
    def write(self, text: str, /) -> int: ...


def _run_serve(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="paitrace",
        description="Serve a local viewer for pydantic-ai trace dumps.",
        epilog=(
            "Use `paitrace export --help` for HTML, `paitrace text --help` for plain text, "
            "or `paitrace json --help` for compact JSON."
        ),
    )
    parser.add_argument(
        "paths",
        type=Path,
        nargs="*",
        help=".json/.jsonl trace files, one directory, or - for stdin",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--no-open", action="store_true", help="do not open the browser")
    parser.add_argument("--version", action="version", version=f"paitrace {__version__}")
    args = parser.parse_args(argv)

    paths: list[Path] = args.paths
    if not paths or paths == [Path("-")]:
        text = _read_stdin(parser, explicit=paths == [Path("-")])
        format = scan.detect_trace_format(text)
        try:
            scan.validate_trace_data(text, format=format, name="stdin")
        except scan.TraceLookupError as exc:
            raise CliError(str(exc)) from exc
        with tempfile.TemporaryDirectory(prefix="paitrace-") as directory:
            temporary_path = Path(directory) / f"stdin.{format}"
            temporary_path.write_text(text, encoding="utf-8")
            return _serve_source(
                temporary_path,
                display_name=str(temporary_path),
                host=args.host,
                port=args.port,
                no_open=args.no_open,
            )

    if Path("-") in paths:
        raise CliError("stdin cannot be combined with file or directory inputs")
    if len(paths) > 1:
        for path in paths:
            _require_trace_file(path)
        try:
            collection = scan.TraceCollection.from_paths(paths)
        except ValueError as exc:
            raise CliError(str(exc)) from exc
        return _serve_source(
            collection,
            display_name=f"{len(paths)} selected traces",
            host=args.host,
            port=args.port,
            no_open=args.no_open,
        )

    root = paths[0]
    if not root.exists():
        raise CliError(f"path does not exist: {root}")
    if root.is_file() and root.suffix not in scan.TRACE_SUFFIXES:
        raise CliError(f"not a trace file (expected .json or .jsonl): {root}")
    return _serve_source(
        root,
        display_name=str(root),
        host=args.host,
        port=args.port,
        no_open=args.no_open,
    )


def _serve_source(
    source: Path | scan.TraceCollection,
    *,
    display_name: str,
    host: str,
    port: int,
    no_open: bool,
) -> int:
    url = f"http://{host}:{port}/"

    def on_bound() -> None:
        print(f"paitrace serving {display_name} at {url}")
        if not no_open:
            browser_timer = threading.Timer(0.5, webbrowser.open, args=[url])
            browser_timer.daemon = True  # never keep the process alive
            browser_timer.start()

    from .server import ServerStartError, serve

    try:
        serve(source, host=host, port=port, on_bound=on_bound)
    except ServerStartError as exc:
        raise CliError(f"{exc} — pick another port with --port") from exc
    return 0


def _run_export(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="paitrace export", description="Export a trace as a self-contained HTML file."
    )
    parser.add_argument(
        "input", type=Path, nargs="?", help="a .json/.jsonl trace file or - for stdin"
    )
    parser.add_argument("-o", "--output", type=Path, help="output path (default: INPUT.html)")
    parser.add_argument(
        "--line", type=int, help="1-based trace line for .jsonl inputs with multiple traces"
    )
    args = parser.parse_args(argv)

    if args.output is None and (args.input is None or args.input == Path("-")):
        raise CliError("--output is required when exporting stdin")
    output = args.output or args.input.with_suffix(".html")

    try:
        loaded = _load_trace(args.input, args.line, parser)
        from .export import write_export_html

        write_export_html(loaded.text, output, trace_name=loaded.name)
    except (scan.TraceLookupError, FileNotFoundError, OSError, UnicodeError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    print(f"wrote {output}")
    return 0


def _run_text(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="paitrace text",
        description="Render a trace as compact plain text (default: stdout).",
    )
    parser.add_argument(
        "input", type=Path, nargs="?", help="a .json/.jsonl trace file or - for stdin"
    )
    parser.add_argument("-o", "--output", type=Path, help="write to this file instead of stdout")
    parser.add_argument(
        "--line", type=int, help="1-based trace line for .jsonl inputs with multiple traces"
    )
    args = parser.parse_args(argv)

    try:
        loaded = _load_trace(args.input, args.line, parser)
        from .text import format_trace_json_as_text

        rendered = format_trace_json_as_text(loaded.text, loaded.name)
        _write_output(rendered, args.output)
    except (scan.TraceLookupError, OSError, UnicodeError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    return 0


def _run_json(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="paitrace json",
        description="Render a trace as compact, structured JSON (default: stdout).",
    )
    parser.add_argument(
        "inputs", type=Path, nargs="*", help=".json/.jsonl trace files or - for stdin"
    )
    parser.add_argument("-o", "--output", type=Path, help="write to this file instead of stdout")
    parser.add_argument(
        "--line", type=int, help="1-based trace line for .jsonl inputs with multiple traces"
    )
    parser.add_argument(
        "--all", action="store_true", help="render every input trace as compact JSONL"
    )
    parser.add_argument("--pretty", action="store_true", help="indent single-trace JSON output")
    args = parser.parse_args(argv)

    try:
        inputs: list[Path] = args.inputs
        multiple = len(inputs) > 1
        if multiple and Path("-") in inputs:
            raise CliError("stdin cannot be combined with file inputs")
        if multiple and args.line is not None:
            raise CliError("--line requires exactly one input")
        if multiple and args.pretty:
            raise CliError("--pretty requires exactly one input")
        if args.all and args.line is not None:
            raise CliError("--all and --line cannot be used together")
        if args.all and args.pretty:
            raise CliError("--all and --pretty cannot be used together")
        if args.all or multiple:
            _write_json_batch(inputs, expand_jsonl=args.all, output=args.output, parser=parser)
            return 0

        input_path = inputs[0] if inputs else None
        loaded = _load_trace(input_path, args.line, parser)
        from .trajectory import format_trace_json_as_compact_json

        rendered = format_trace_json_as_compact_json(
            loaded.text,
            name=loaded.name,
            indent=2 if args.pretty else None,
        )
        _write_output(rendered, args.output)
    except (scan.TraceLookupError, OSError, UnicodeError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    return 0


def _load_trace(
    input_path: Path | None,
    line: int | None,
    parser: argparse.ArgumentParser,
) -> LoadedTrace:
    if input_path is None or input_path == Path("-"):
        text = _read_stdin(parser, explicit=input_path == Path("-"))
        format = scan.detect_trace_format(text)
        selected = scan.select_trace(text, format=format, name="stdin", line=line)
        return LoadedTrace(selected, "stdin")

    format = _require_trace_file(input_path)
    text = scan.read_trace(input_path.parent, input_path.name, line)
    selected_line = (line or 1) if format == "jsonl" else None
    name = (
        f"{input_path.name} · trace {selected_line}"
        if selected_line is not None
        else input_path.name
    )
    return LoadedTrace(text, name)


def _write_json_batch(
    input_paths: list[Path],
    *,
    expand_jsonl: bool,
    output: Path | None,
    parser: argparse.ArgumentParser,
) -> None:
    if not input_paths or input_paths == [Path("-")]:
        source = _stdin_stream(parser, explicit=input_paths == [Path("-")])
        traces = (
            LoadedTrace(trace_json, f"stdin · trace {trace_number}")
            for trace_number, trace_json in scan.iter_jsonl_traces(source, name="stdin")
        )
        _write_compact_traces(traces, output=output)
        return

    formats: list[Literal["json", "jsonl"]] = [_require_trace_file(path) for path in input_paths]
    if len(input_paths) > 1:
        try:
            collection = scan.TraceCollection.from_paths(input_paths)
        except ValueError as exc:
            raise CliError(str(exc)) from exc
        names = [selected.key for selected in collection.files]
    else:
        names = [input_paths[0].name]
    sources: list[tuple[Path, Literal["json", "jsonl"], str]] = list(
        zip(input_paths, formats, names, strict=True)
    )
    if not expand_jsonl:
        jsonl = next((path for path, format, _ in sources if format == "jsonl"), None)
        if jsonl is not None:
            raise CliError(f"multiple inputs containing JSONL require --all: {jsonl}")
    if output is not None and output.resolve() in {path.resolve() for path in input_paths}:
        raise CliError("--output must differ from every batch input")
    _write_compact_traces(_iter_file_traces(sources), output=output)


def _iter_file_traces(
    sources: list[tuple[Path, Literal["json", "jsonl"], str]],
) -> Iterable[LoadedTrace]:
    for path, format, name in sources:
        if format == "json":
            yield LoadedTrace(scan.read_trace(path.parent, path.name, line=None), name)
            continue
        with path.open(encoding="utf-8") as lines:
            for trace_number, trace_json in scan.iter_jsonl_traces(lines, name=name):
                yield LoadedTrace(trace_json, f"{name} · trace {trace_number}")


def _write_compact_traces(traces: Iterable[LoadedTrace], *, output: Path | None) -> None:
    if output is None:
        _render_compact_traces(traces, stream=sys.stdout)
        return
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as stream:
            temporary_path = Path(stream.name)
            _render_compact_traces(traces, stream=stream)
        temporary_path.replace(output)
    except BaseException:
        if temporary_path is not None:
            with contextlib.suppress(OSError):
                temporary_path.unlink()
        raise
    print(f"wrote {output}", file=sys.stderr)


def _render_compact_traces(traces: Iterable[LoadedTrace], *, stream: TextWriter) -> None:
    from .trajectory import format_trace_json_as_compact_json

    for trace in traces:
        stream.write(format_trace_json_as_compact_json(trace.text, name=trace.name))


def _require_trace_file(input_path: Path) -> Literal["json", "jsonl"]:
    if input_path.is_dir():
        raise CliError(f"expected a .json or .jsonl trace file, got directory: {input_path}")
    if not input_path.exists():
        raise CliError(f"input file does not exist: {input_path}")
    if not input_path.is_file():
        raise CliError(f"expected a trace file: {input_path}")
    if input_path.suffix not in scan.TRACE_SUFFIXES:
        raise CliError(f"not a trace file (expected .json or .jsonl): {input_path}")
    return scan.TRACE_SUFFIXES[input_path.suffix]


def _read_stdin(parser: argparse.ArgumentParser, *, explicit: bool) -> str:
    return _stdin_stream(parser, explicit=explicit).read()


def _stdin_stream(parser: argparse.ArgumentParser, *, explicit: bool) -> TextIO:
    if not explicit and sys.stdin.isatty():
        parser.print_usage(file=sys.stderr)
        raise CliError("input is required when stdin is interactive")
    return sys.stdin


def _write_output(rendered: str, output: Path | None) -> None:
    if output is None:
        sys.stdout.write(rendered)
        return
    output.write_text(rendered, encoding="utf-8")
    print(f"wrote {output}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
