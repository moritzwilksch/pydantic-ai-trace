"""`paitrace` command line interface.

`paitrace PATH` serves traces; `export`, `text`, `json`, and `stats` are subcommands. A
command word is still treated as a path when a file or directory with that name exists.
"""

from __future__ import annotations

import argparse
import contextlib
import ipaddress
import os
import sys
import tempfile
import threading
import webbrowser
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol, TextIO

from . import __version__, scan

if TYPE_CHECKING:
    from .payload import TracePayload

DEFAULT_PORT = 1205
DEFAULT_HOST = "127.0.0.1"

_TRACE_FORMATS = """\
A trace is a message list (`ModelMessagesTypeAdapter.dump_json`) or a trajectory
(`Trajectory.model_dump_json`). A .json file holds one trace; a .jsonl file holds
one per line."""
_INPUT_HELP = "a .json or .jsonl trace file, or - for stdin (default: stdin when piped)"
_LINE_HELP = "which trace of a multi-trace .jsonl input to use, counting from 1"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        status = _run(argv)
        sys.stdout.flush()  # Surface a closed pipe here, not at interpreter exit.
        return status
    except BrokenPipeError:
        # The reader, such as `head` or `less`, stopped reading. Point stdout at devnull so
        # the interpreter's final flush cannot fail too.
        # https://docs.python.org/3/library/signal.html#note-on-sigpipe
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 1
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _run(argv: list[str]) -> int:
    if argv and argv[0] == "export" and not Path("export").exists():
        return _run_export(argv[1:])
    if argv and argv[0] == "text" and not Path("text").exists():
        return _run_text(argv[1:])
    if argv and argv[0] == "json" and not Path("json").exists():
        return _run_json(argv[1:])
    if argv and argv[0] == "stats" and not Path("stats").exists():
        return _run_stats(argv[1:])
    return _run_serve(argv)


class CliError(Exception):
    pass


@dataclass(frozen=True)
class LoadedTrace:
    text: str
    name: str

    def payload(self) -> TracePayload:
        from .load import TraceLoadError, load_trajectory
        from .payload import build_payload

        try:
            trajectory = load_trajectory(self.text, name=self.name)
        except TraceLoadError as exc:
            raise TraceLoadError(f"{self.name}: {exc}") from exc
        return build_payload(trajectory, name=self.name)


class TextWriter(Protocol):
    def write(self, text: str, /) -> int: ...


def _run_serve(argv: list[str]) -> int:
    parser = _parser(
        "paitrace",
        usage="%(prog)s [options] [PATHS ...]\n       %(prog)s {export,text,json,stats} ...",
        description=f"""\
Browse Pydantic AI traces in a local web viewer. The viewer lists every trace
under a directory, or the files you name, and reloads a trace when it changes
on disk.

{_TRACE_FORMATS}""",
        epilog="""\
commands:
  export    write one trace as a self-contained HTML file
  text      print one trace as a plain-text transcript
  json      print traces as compact JSON for jq, scripts, and agents
  stats     print LLM calls, tokens, cost, and wall time per trace

Run `paitrace COMMAND --help` for a command's options.

examples:
  paitrace trace.json
  paitrace ./traces/
  paitrace first.json runs.jsonl --port 8080
  curl -s https://example.test/trace.json | paitrace""",
    )
    parser.add_argument(
        "paths",
        metavar="PATHS",
        type=Path,
        nargs="*",
        help="a directory, one or more .json/.jsonl trace files, or - for stdin "
        "(default: stdin when piped)",
    )
    parser.add_argument(
        "--port",
        type=int,
        help=f"port to listen on (default: {DEFAULT_PORT}, or a free port when it is busy)",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help="address to bind (default: %(default)s); the viewer has no authentication, "
        "so any other address exposes every trace to whoever can reach the port",
    )
    parser.add_argument("--no-open", action="store_true", help="do not open a browser tab")
    parser.add_argument("--version", action="version", version=f"paitrace {__version__}")
    if not argv and sys.stdin.isatty():
        parser.print_help()
        return 0
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
    port: int | None,
    no_open: bool,
) -> int:
    if not _is_loopback(host):
        print(
            f"warning: serving on {host} without authentication; "
            "anyone who can reach this port can read every trace",
            file=sys.stderr,
        )

    def on_bound(bound_port: int) -> None:
        url = _browser_url(host, bound_port)
        print(f"paitrace serving {display_name} at {url} (Ctrl-C to stop)", file=sys.stderr)
        if not no_open:
            browser_timer = threading.Timer(0.5, webbrowser.open, args=[url])
            browser_timer.daemon = True  # never keep the process alive
            browser_timer.start()

    from .server import ServerStartError, serve

    ports = [DEFAULT_PORT, 0] if port is None else [port]  # 0: any free port
    try:
        serve(source, host=host, ports=ports, on_bound=on_bound)
    except ServerStartError as exc:
        hint = "; pick another port with --port" if port is not None else ""
        raise CliError(f"{exc}{hint}") from exc
    return 0


def _browser_url(host: str, port: int) -> str:
    """A URL a local browser can open; a wildcard address is not one."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:  # a hostname
        return f"http://{host}:{port}/"
    if address.is_unspecified:
        return f"http://localhost:{port}/"
    if address.version == 6:
        return f"http://[{host}]:{port}/"
    return f"http://{host}:{port}/"


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:  # a hostname
        return False


def _run_export(argv: list[str]) -> int:
    parser = _parser(
        "paitrace export",
        description=f"""\
Write one trace as a self-contained HTML file. The file embeds the trace, its
costs, and the viewer, so it opens offline in any browser.

{_TRACE_FORMATS}""",
        epilog="""\
examples:
  paitrace export trace.json                 # writes trace.html
  paitrace export runs.jsonl --line 2 -o run2.html
  curl -s https://example.test/trace.json | paitrace export -o trace.html""",
    )
    parser.add_argument("input", metavar="INPUT", type=Path, nargs="?", help=_INPUT_HELP)
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="where to write the HTML (default: INPUT with an .html suffix; required for stdin)",
    )
    parser.add_argument("--line", type=int, help=_LINE_HELP)
    args = parser.parse_args(argv)

    if args.output is None and (args.input is None or args.input == Path("-")):
        raise CliError("--output is required when exporting stdin")
    output = args.output or args.input.with_suffix(".html")
    _require_output_not_input(output, [args.input])

    try:
        loaded = _load_trace(args.input, args.line, parser)
        from ._html import payload_document

        output.write_text(payload_document(loaded.payload()), encoding="utf-8")
    except (scan.TraceLookupError, FileNotFoundError, OSError, UnicodeError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    print(f"wrote {output}", file=sys.stderr)
    return 0


def _run_text(argv: list[str]) -> int:
    parser = _parser(
        "paitrace text",
        description=f"""\
Print one trace as a plain-text transcript: every run, request, and response in
order, with token usage and cost. Instructions are printed only when they change.
This is the text the viewer's "Copy trace" button copies.

{_TRACE_FORMATS}""",
        epilog="""\
examples:
  paitrace text trace.json | less
  paitrace text runs.jsonl --line 2 -o run2.txt""",
    )
    parser.add_argument("input", metavar="INPUT", type=Path, nargs="?", help=_INPUT_HELP)
    parser.add_argument("-o", "--output", type=Path, help="write to this file instead of stdout")
    parser.add_argument("--line", type=int, help=_LINE_HELP)
    args = parser.parse_args(argv)
    _require_output_not_input(args.output, [args.input])

    try:
        loaded = _load_trace(args.input, args.line, parser)
        _write_output(loaded.payload().transcript, args.output)
    except BrokenPipeError:
        raise  # stdout closed; `main` handles it
    except (scan.TraceLookupError, OSError, UnicodeError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    return 0


def _run_json(argv: list[str]) -> int:
    parser = _parser(
        "paitrace json",
        description=f"""\
Print traces as compact, structured JSON for jq, scripts, and AI agents. Each
document has the trace's name, its stats, and its runs with their messages,
outcomes, stats, and costs. Display headings, repeated instructions, provider
response IDs, and binary payloads are left out.

One input prints one JSON document. Several inputs, or --all, print JSONL with
one document per trace.

{_TRACE_FORMATS}""",
        epilog="""\
examples:
  paitrace json trace.json --pretty
  paitrace json trace.json | jq '.stats'
  paitrace json runs.jsonl --all -o compact.jsonl
  paitrace json first.json second.json | jq -s '.'""",
    )
    parser.add_argument(
        "inputs",
        metavar="INPUTS",
        type=Path,
        nargs="*",
        help=".json or .jsonl trace files, or - for stdin (default: stdin when piped)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="write to this file instead of stdout; JSONL output replaces the file only "
        "after every trace converts",
    )
    parser.add_argument("--line", type=int, help=_LINE_HELP)
    parser.add_argument(
        "--all",
        action="store_true",
        help="print every trace of every input, including each line of .jsonl inputs",
    )
    parser.add_argument("--pretty", action="store_true", help="indent a single document")
    args = parser.parse_args(argv)

    inputs: list[Path] = args.inputs
    # One document per trace has no single-document form for a directory; a
    # shell glob names its traces explicitly.
    directory = next((path for path in inputs if path.is_dir()), None)
    if directory is not None:
        raise CliError(
            f"expected .json or .jsonl trace files, got directory: {directory}; "
            f"pass its traces instead, e.g. paitrace json {directory / '*.json'} --all"
        )
    _require_output_not_input(args.output, inputs)
    try:
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
        from .compact import format_compact_json

        rendered = format_compact_json(loaded.payload(), indent=2 if args.pretty else None)
        _write_output(rendered, args.output)
    except BrokenPipeError:
        raise  # stdout closed; `main` handles it
    except (scan.TraceLookupError, OSError, UnicodeError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    return 0


def _run_stats(argv: list[str]) -> int:
    parser = _parser(
        "paitrace stats",
        description=f"""\
Print one summary row per trace: runs, LLM calls, input, cached, and output
tokens, cost, and wall time, with a totals row for several traces. A trace
with several runs gets one indented row per run, counting only that run's own
calls, tokens, and cost. A directory is searched like the viewer's sidebar.
Traces that do not validate are listed with their error after the table, and
the exit status is 1.

{_TRACE_FORMATS}""",
        epilog="""\
examples:
  paitrace stats ./traces/
  paitrace stats first.json runs.jsonl
  paitrace stats ./traces/ --json | jq -s '[.[].runs[]?] | group_by(.name)'""",
    )
    parser.add_argument(
        "paths",
        metavar="PATHS",
        type=Path,
        nargs="*",
        help="directories or .json/.jsonl trace files, or - for stdin (default: stdin when piped)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print JSONL: {name, stats, runs: [{id, name, parent, stats}]} per trace, "
        "or {name, error} when invalid",
    )
    args = parser.parse_args(argv)

    from .stats import InvalidTrace, StatsRow, format_jsonl, format_table, source_rows

    paths: list[Path] = args.paths
    if Path("-") in paths and len(paths) > 1:
        raise CliError("stdin cannot be combined with file or directory inputs")
    rows: list[StatsRow] = []
    if not paths or paths == [Path("-")]:
        text = _read_stdin(parser, explicit=paths == [Path("-")])
        rows.extend(source_rows([text], format=scan.detect_trace_format(text), name="stdin"))
    else:
        for path in paths:
            for file, name in _stats_files(path, prefix=len(paths) > 1):
                format = _require_trace_file(file)
                try:
                    with file.open(encoding="utf-8") as stream:
                        # Stream JSONL so a large evaluation log is never held whole.
                        chunks = [stream.read()] if format == "json" else stream
                        for row in source_rows(chunks, format=format, name=name):
                            rows.append(row)
                except (OSError, UnicodeDecodeError) as exc:
                    rows.append(InvalidTrace(name=name, error=f"cannot read file: {exc}"))

    sys.stdout.write(format_jsonl(rows) if args.json else format_table(rows))
    return 1 if any(isinstance(row, InvalidTrace) for row in rows) else 0


def _stats_files(path: Path, *, prefix: bool) -> list[tuple[Path, str]]:
    """Trace files under `path`, named relative to a directory argument."""
    if not path.is_dir():
        return [(path, path.as_posix())]
    base = path.parent if prefix else path
    return [(file, file.relative_to(base).as_posix()) for file in scan.iter_trace_files(path)]


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
    from .compact import format_compact_json

    for trace in traces:
        stream.write(format_compact_json(trace.payload()))


def _parser(
    prog: str, *, description: str, epilog: str, usage: str | None = None
) -> argparse.ArgumentParser:
    """A parser whose description and examples keep their line breaks."""
    return argparse.ArgumentParser(
        prog=prog,
        usage=usage,
        description=description,
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )


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


def _require_output_not_input(output: Path | None, inputs: Iterable[Path | None]) -> None:
    """Refuse to write over an input, under any path that names the same file."""
    if output is None or not output.exists():
        return
    for path in inputs:
        if path is not None and path != Path("-") and path.exists() and output.samefile(path):
            raise CliError(f"--output must differ from the input: {path}")


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
