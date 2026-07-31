"""`paitrace` command line interface.

`paitrace PATH` serves a trace file or directory; `paitrace export` writes a
self-contained HTML file; and `paitrace text` writes the compact plain-text
representation. A command word is still treated as a path when a file or
directory with that name exists.
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from pathlib import Path

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
        return _run_serve(argv)
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


class CliError(Exception):
    pass


def _run_serve(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="paitrace",
        description="Serve a local viewer for pydantic-ai trace dumps.",
        epilog="Use `paitrace export --help` for HTML or `paitrace text --help` for plain text.",
    )
    parser.add_argument("path", type=Path, help="a .json/.jsonl trace file or a directory")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--no-open", action="store_true", help="do not open the browser")
    parser.add_argument("--version", action="version", version=f"paitrace {__version__}")
    args = parser.parse_args(argv)

    root: Path = args.path
    if not root.exists():
        raise CliError(f"path does not exist: {root}")
    if root.is_file() and root.suffix not in scan.TRACE_SUFFIXES:
        raise CliError(f"not a trace file (expected .json or .jsonl): {root}")

    url = f"http://{args.host}:{args.port}/"

    def on_bound() -> None:
        print(f"paitrace serving {root} at {url}")
        if not args.no_open:
            browser_timer = threading.Timer(0.5, webbrowser.open, args=[url])
            browser_timer.daemon = True  # never keep the process alive
            browser_timer.start()

    from .server import ServerStartError, serve

    try:
        serve(root, host=args.host, port=args.port, on_bound=on_bound)
    except ServerStartError as exc:
        raise CliError(f"{exc} — pick another port with --port") from exc
    return 0


def _run_export(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="paitrace export", description="Export a trace as a self-contained HTML file."
    )
    parser.add_argument("input", type=Path, help="a .json or .jsonl trace file")
    parser.add_argument("-o", "--output", type=Path, help="output path (default: INPUT.html)")
    parser.add_argument(
        "--line", type=int, help="1-based trace line for .jsonl inputs with multiple traces"
    )
    args = parser.parse_args(argv)

    if not args.input.is_file():
        raise CliError(f"input file does not exist: {args.input}")
    output = args.output or args.input.with_suffix(".html")

    from .export import export_html

    try:
        export_html(args.input, output, line=args.line)
    except (scan.TraceLookupError, FileNotFoundError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    print(f"wrote {output}")
    return 0


def _run_text(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="paitrace text",
        description="Render a trace as compact plain text (default: stdout).",
    )
    parser.add_argument("input", type=Path, help="a .json or .jsonl trace file")
    parser.add_argument("-o", "--output", type=Path, help="write to this file instead of stdout")
    parser.add_argument(
        "--line", type=int, help="1-based trace line for .jsonl inputs with multiple traces"
    )
    args = parser.parse_args(argv)

    if not args.input.is_file():
        raise CliError(f"input file does not exist: {args.input}")

    try:
        trace_json = scan.read_trace(args.input.parent, args.input.name, args.line)
        from .text import format_trace_json_as_text

        line = (args.line or 1) if args.input.suffix == ".jsonl" else None
        name = f"{args.input.name} · trace {line}" if line is not None else args.input.name
        rendered = format_trace_json_as_text(trace_json, name)
        if args.output is None:
            sys.stdout.write(rendered)
        else:
            args.output.write_text(rendered, encoding="utf-8")
            print(f"wrote {args.output}", file=sys.stderr)
    except (scan.TraceLookupError, OSError, UnicodeError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    return 0


if __name__ == "__main__":
    sys.exit(main())
