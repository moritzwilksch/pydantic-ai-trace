"""Starlette app serving the viewer SPA and the trace API."""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from . import scan
from .export import packaged_index_html
from .text import format_trace_json_as_text

WATCH_DEBOUNCE_MS = 200


class ServerStartError(Exception):
    pass


class _TraceJSONResponse(JSONResponse):
    """JSON response that safely escapes untrusted trace text."""

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=True,
            allow_nan=False,
            indent=None,
            separators=(",", ":"),
        ).encode("utf-8")


def serve(
    root: Path,
    host: str,
    port: int,
    on_bound: Callable[[], None] | None = None,
) -> None:
    """Run the viewer server until interrupted; Ctrl-C always exits promptly."""
    import uvicorn

    stop_event = asyncio.Event()
    config = uvicorn.Config(
        create_app(root, stop_event),
        host=host,
        port=port,
        log_level="warning",
        # Backstop: force-close anything still open shortly after shutdown starts.
        timeout_graceful_shutdown=1,
    )

    class _Server(uvicorn.Server):
        async def shutdown(self, sockets: Any = None) -> None:
            # End SSE streams (/api/events) first so connections drain cleanly
            # instead of hanging until uvicorn force-cancels them.
            stop_event.set()
            await super().shutdown(sockets=sockets)

    # Bind once and hand that same socket to Uvicorn. A separate availability
    # check would release the port and race with the real server bind.
    try:
        sock = config.bind_socket()
    except SystemExit as exc:
        raise ServerStartError(f"cannot bind {host}:{port}") from exc
    if on_bound is not None:
        on_bound()

    # Like uvicorn.run(): Ctrl-C is a clean exit, not a crash.
    with contextlib.suppress(KeyboardInterrupt):
        _Server(config).run(sockets=[sock])


def create_app(root: Path, stop_event: asyncio.Event | None = None) -> Starlette:
    root = root.resolve()
    mode = "file" if root.is_file() else "dir"
    serve_root = root.parent if mode == "file" else root

    async def index(_: Request) -> Response:
        return HTMLResponse(_load_index_html())

    async def meta(_: Request) -> Response:
        return JSONResponse({"mode": mode, "root": root.name})

    async def tree(_: Request) -> Response:
        return JSONResponse(await asyncio.to_thread(scan.build_tree, root))

    async def trace(request: Request) -> Response:
        relative_path = request.query_params.get("path", "")
        line_param = request.query_params.get("line")
        try:
            line = int(line_param) if line_param is not None else None
        except ValueError:
            return JSONResponse({"error": f"invalid line: {line_param!r}"}, status_code=400)
        if mode == "file" and relative_path != root.name:
            return JSONResponse({"error": f"not found: {relative_path}"}, status_code=404)
        try:
            text = await asyncio.to_thread(scan.read_trace, serve_root, relative_path, line)
        except scan.TraceLookupError as exc:
            return JSONResponse({"error": str(exc)}, status_code=exc.status_code)
        name = f"{relative_path} · trace {line}" if line is not None else relative_path
        transcript = await asyncio.to_thread(format_trace_json_as_text, text, name)
        return _TraceJSONResponse(
            {
                "source": text,
                "transcript": transcript,
            }
        )

    async def events(_: Request) -> Response:
        only = root.name if mode == "file" else None
        return _SSEResponse(
            _change_events(serve_root, only=only, stop_event=stop_event),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return Starlette(
        routes=[
            Route("/", index),
            Route("/api/meta", meta),
            Route("/api/tree", tree),
            Route("/api/trace", trace),
            Route("/api/events", events),
        ]
    )


class _SSEResponse(StreamingResponse):
    """StreamingResponse that ends quietly when cancelled.

    On shutdown the stream normally ends via the stop event, but if uvicorn's
    backstop force-cancels a lingering connection, swallow the cancellation
    instead of letting uvicorn log an "Exception in ASGI application" traceback.
    """

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            await super().__call__(scope, receive, send)


async def _change_events(base: Path, only: str | None, stop_event: asyncio.Event | None):
    """Yield SSE events for trace changes under `base` (restricted to `only` if given).

    Watching the directory (not a single file) survives delete/recreate of the
    root file in file mode; if `base` itself disappears the stream just ends
    and the client's EventSource retry takes over.
    """
    from watchfiles import awatch  # deferred: import is slow, only /api/events pays for it

    yield "retry: 1000\n\n"
    with contextlib.suppress(FileNotFoundError):
        async for changes in awatch(
            base, debounce=WATCH_DEBOUNCE_MS, step=50, stop_event=stop_event
        ):
            paths = sorted(
                {
                    Path(changed).relative_to(base).as_posix()
                    for _, changed in changes
                    if Path(changed).suffix in scan.TRACE_SUFFIXES
                    and Path(changed).is_relative_to(base)
                }
            )
            if only is not None:
                paths = [path for path in paths if path == only]
            if paths:
                payload = json.dumps({"type": "changed", "paths": paths})
                yield f"data: {payload}\n\n"


def _load_index_html() -> str:
    try:
        return packaged_index_html()
    except FileNotFoundError:
        return (
            "<h1>Frontend assets missing</h1>"
            "<p>This is a source checkout without built assets. "
            "Run <code>pixi run build-frontend</code>, or use the Vite dev server "
            "(<code>pixi run dev-web</code>) during development.</p>"
        )
