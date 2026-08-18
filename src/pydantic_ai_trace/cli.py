"""`paitrace` command line interface.

`paitrace PATH` serves a trace file or directory; `paitrace export` writes HTML;
and `paitrace text` or `paitrace json` writes a compact representation. Trace
commands accept a path or stdin. A command word is still treated as a path when
a file or directory with that name exists.
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
        "path",
        type=Path,
        nargs="?",
        help="a .json/.jsonl trace file, a directory, or - for stdin",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--no-open", action="store_true", help="do not open the browser")
    parser.add_argument("--version", action="version", version=f"paitrace {__version__}")
    args = parser.parse_args(argv)

    root: Path | None = args.path
    if root is None or root == Path("-"):
        text = _read_stdin(parser, explicit=root == Path("-"))
        format = scan.detect_trace_format(text)
        try:
            scan.validate_trace_data(text, format=format, name="stdin")
        except scan.TraceLookupError as exc:
            raise CliError(str(exc)) from exc
        with tempfile.TemporaryDirectory(prefix="paitrace-") as directory:
            temporary_path = Path(directory) / f"stdin.{format}"
            temporary_path.write_text(text, encoding="utf-8")
            return _serve_path(temporary_path, args.host, args.port, args.no_open)

    if not root.exists():
        raise CliError(f"path does not exist: {root}")
    if root.is_file() and root.suffix not in scan.TRACE_SUFFIXES:
        raise CliError(f"not a trace file (expected .json or .jsonl): {root}")
    return _serve_path(root, args.host, args.port, args.no_open)


def _serve_path(root: Path, host: str, port: int, no_open: bool) -> int:
    url = f"http://{host}:{port}/"

    def on_bound() -> None:
        print(f"paitrace serving {root} at {url}")
        if not no_open:
            browser_timer = threading.Timer(0.5, webbrowser.open, args=[url])
            browser_timer.daemon = True  # never keep the process alive
            browser_timer.start()

    from .server import ServerStartError, serve

    try:
        serve(root, host=host, port=port, on_bound=on_bound)
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
        "input", type=Path, nargs="?", help="a .json/.jsonl trace file or - for stdin"
    )
    parser.add_argument("-o", "--output", type=Path, help="write to this file instead of stdout")
    parser.add_argument(
        "--line", type=int, help="1-based trace line for .jsonl inputs with multiple traces"
    )
    parser.add_argument(
        "--all", action="store_true", help="render every JSONL trace as compact JSONL"
    )
    parser.add_argument("--pretty", action="store_true", help="indent single-trace JSON output")
    args = parser.parse_args(argv)

    try:
        if args.all and args.line is not None:
            raise CliError("--all and --line cannot be used together")
        if args.all and args.pretty:
            raise CliError("--all and --pretty cannot be used together")
        if args.all:
            _write_all_traces(args.input, args.output, parser)
            return 0

        loaded = _load_trace(args.input, args.line, parser)
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


def _write_all_traces(
    input_path: Path | None,
    output: Path | None,
    parser: argparse.ArgumentParser,
) -> None:
    if input_path is None or input_path == Path("-"):
        source = _stdin_stream(parser, explicit=input_path == Path("-"))
        _write_compact_jsonl(source, name="stdin", output=output)
        return

    format = _require_trace_file(input_path)
    if format != "jsonl":
        raise CliError(f"--all requires .jsonl input: {input_path}")
    if output is not None and output.resolve() == input_path.resolve():
        raise CliError("--output must differ from the JSONL input when using --all")
    with input_path.open(encoding="utf-8") as source:
        _write_compact_jsonl(source, name=input_path.name, output=output)


def _write_compact_jsonl(lines: Iterable[str], *, name: str, output: Path | None) -> None:
    if output is None:
        _render_compact_jsonl(lines, name=name, stream=sys.stdout)
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
            _render_compact_jsonl(lines, name=name, stream=stream)
        temporary_path.replace(output)
    except BaseException:
        if temporary_path is not None:
            with contextlib.suppress(OSError):
                temporary_path.unlink()
        raise
    print(f"wrote {output}", file=sys.stderr)


def _render_compact_jsonl(lines: Iterable[str], *, name: str, stream: TextWriter) -> None:
    from .trajectory import format_trace_json_as_compact_json

    for trace_number, trace_json in scan.iter_jsonl_traces(lines, name=name):
        trace_name = f"{name} · trace {trace_number}"
        stream.write(format_trace_json_as_compact_json(trace_json, name=trace_name))


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
