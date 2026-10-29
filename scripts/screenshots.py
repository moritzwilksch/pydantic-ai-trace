"""Render the README screenshots: the viewer on a demo run tree, in light and dark theme.

Run with `pixi run screenshots`. It writes `docs/screenshot-light.png` and
`docs/screenshot-dark.png`. The demo run tree is built from Pydantic AI message classes
here, so it stays in the canonical wire shape.
"""

from __future__ import annotations

import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from playwright.sync_api import Page, sync_playwright
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.usage import RequestUsage

from pydantic_ai_trace import Run, RunTree

DOCS = Path(__file__).resolve().parent.parent / "docs"
START = datetime(2026, 1, 15, 9, 30, tzinfo=UTC)
VIEWPORT = {"width": 1400, "height": 1100}

type Theme = Literal["light", "dark"]


def at(seconds: float) -> datetime:
    return START + timedelta(seconds=seconds)


def request(
    seconds: float, *parts: UserPromptPart | ToolReturnPart, instructions: str | None = None
) -> ModelRequest:
    return ModelRequest(parts=list(parts), timestamp=at(seconds), instructions=instructions)


def tool_return(seconds: float, call: ToolCallPart, content: object) -> ToolReturnPart:
    return ToolReturnPart(
        tool_name=call.tool_name,
        content=content,
        tool_call_id=call.tool_call_id,
        timestamp=at(seconds),
    )


def response(
    seconds: float,
    *parts: ThinkingPart | ToolCallPart,
    model: tuple[str, str],
    tokens: tuple[int, int, int],
) -> ModelResponse:
    provider, model_name = model
    input_tokens, cache_read_tokens, output_tokens = tokens
    return ModelResponse(
        parts=list(parts),
        usage=RequestUsage(
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
        ),
        model_name=model_name,
        provider_name=provider,
        timestamp=at(seconds),
        finish_reason="tool_call",
    )


def demo_run_tree() -> RunTree:
    """A research agent that searches, delegates a fact check, and returns a structured report."""
    gpt = ("openai", "gpt-5")
    haiku = ("anthropic", "claude-haiku-4-5")

    search_population = ToolCallPart(
        "web_search", {"query": "largest EU cities by population 2025"}, "call_search_1"
    )
    verify = ToolCallPart(
        "verify_claims",
        {"claim": "Berlin and Madrid each have more than 3 million residents"},
        "call_verify",
    )
    report_output = {
        "answer": "Berlin and Madrid are the only EU capitals with more than 3 million residents.",
        "capitals": {"Berlin": 3_897_145, "Madrid": 3_460_491},
    }
    report = ToolCallPart("final_result", report_output, "call_final")
    research_messages: list[ModelMessage] = [
        request(
            0,
            UserPromptPart(
                "Which EU capitals have more than 3 million residents? Verify the figures.",
                timestamp=at(0),
            ),
            instructions="You are a research assistant. Search, verify claims with the "
            "fact checker, and answer with a `Report`.",
        ),
        response(
            3.1,
            ThinkingPart(
                "I need current population figures for EU capitals. I'll search for the "
                "largest cities first, then have the fact checker confirm the candidates."
            ),
            search_population,
            model=gpt,
            tokens=(1_240, 0, 186),
        ),
        request(
            3.8,
            tool_return(
                3.8,
                search_population,
                [
                    {"title": "Berlin population 2025", "url": "https://destatis.de/berlin"},
                    {"title": "Madrid: padrón municipal", "url": "https://ine.es/madrid"},
                    {"title": "Rome demographics", "url": "https://istat.it/roma"},
                ],
            ),
        ),
        response(6.2, verify, model=gpt, tokens=(1_810, 1_152, 64)),
        request(
            14.9,
            tool_return(
                14.9,
                verify,
                {"verified": 2, "corrections": ["Berlin: 3,897,145 (2024 register)"]},
            ),
        ),
        response(18.4, report, model=gpt, tokens=(2_035, 1_664, 142)),
        request(18.4, tool_return(18.4, report, "Final result processed.")),
    ]
    research = Run.from_messages(research_messages, name="research_agent")

    fetch = ToolCallPart("fetch_page", {"url": "https://destatis.de/berlin"}, "call_fetch")
    verdicts = ToolCallPart(
        "final_result",
        {
            "verdicts": [
                {"claim": "Berlin has 3.9M residents", "supported": True},
                {"claim": "Madrid has 3.4M residents", "supported": True},
            ]
        },
        "call_verdicts",
    )
    checker_messages: list[ModelMessage] = [
        request(
            6.4,
            UserPromptPart(
                "Verify: Berlin has 3.9M residents; Madrid has 3.4M residents.", timestamp=at(6.4)
            ),
        ),
        response(8.0, fetch, model=haiku, tokens=(620, 0, 48)),
        request(
            9.1,
            tool_return(9.1, fetch, "Population of Berlin on 31 Dec 2024: 3,897,145 residents."),
        ),
        response(14.6, verdicts, model=haiku, tokens=(1_045, 512, 96)),
        request(14.7, tool_return(14.7, verdicts, "Final result processed.")),
    ]
    checker = Run.from_messages(
        checker_messages, name="fact_checker", parent=research, tool_call_id=verify.tool_call_id
    )
    return RunTree(runs=(checker, research))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_until_up(url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"paitrace exited with code {process.returncode}")
        try:
            urllib.request.urlopen(f"{url}/api/meta", timeout=1).close()
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"paitrace did not start at {url}")


def capture(page: Page, url: str, out: Path) -> None:
    page.goto(f"{url}/#/research.json")
    # Select the run explicitly instead of relying on the default selection.
    runs = page.get_by_role("group", name="Runs")
    runs.get_by_role("button", name=re.compile(r"^research_agent")).click()
    page.get_by_title("Open run fact_checker").wait_for()
    # Open the call that started the subagent (message 3) and the output (message 5).
    for part in ("3:0", "5:0"):
        page.locator(f'[data-part="{part}"] > details').evaluate("d => { d.open = true; }")
    page.locator(".trace-body").evaluate("body => { body.scrollTop = 0; }")
    # No focus ring, caret, or hover state; the pointer rests on empty sidebar space.
    page.evaluate("document.activeElement?.blur()")
    page.mouse.move(10, VIEWPORT["height"] - 10)
    # Cards use `content-visibility: auto`; let two frames lay them out.
    page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    page.screenshot(path=out, animations="disabled", caret="hide")


def main() -> None:
    # Fetches the headless browser that matches this Playwright version, once.
    subprocess.run(
        [sys.executable, "-m", "playwright", "install", "chromium-headless-shell"], check=True
    )
    DOCS.mkdir(exist_ok=True)
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory() as tmp:
        traces = Path(tmp) / "traces"
        traces.mkdir()
        (traces / "research.json").write_text(demo_run_tree().model_dump_json())
        cli = [sys.executable, "-m", "pydantic_ai_trace.cli", "--no-open", "--port", str(port)]
        server = subprocess.Popen([*cli, str(traces)])
        try:
            wait_until_up(url, server)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                themes: tuple[Theme, ...] = ("light", "dark")
                for theme in themes:
                    context = browser.new_context(
                        viewport=VIEWPORT,
                        device_scale_factor=2,
                        color_scheme=theme,  # the viewer's initial theme without a stored choice
                        locale="en-US",
                        timezone_id="UTC",
                        reduced_motion="reduce",
                    )
                    out = DOCS / f"screenshot-{theme}.png"
                    capture(context.new_page(), url, out)
                    context.close()
                    print(f"wrote {out}")
                browser.close()
        finally:
            server.terminate()
            server.wait()


if __name__ == "__main__":
    main()
