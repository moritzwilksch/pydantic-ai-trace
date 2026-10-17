"""Generate the example traces in `examples/traces/` from real Pydantic AI agent runs.

Each agent runs against a `FunctionModel` that scripts a realistic conversation. Timestamps,
model names, usage, and IDs are then rewritten deterministically, so regenerating produces the
same files and the viewer can price the calls.

    pixi run gen-examples
"""

from __future__ import annotations

import random
import struct
import uuid
import zlib
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.messages import (
    BinaryContent,
    DocumentUrl,
    ImageUrl,
    ModelMessage,
    ModelMessagesTypeAdapter,
    ModelResponse,
    TextPart,
    ThinkingPart,
    ToolCallPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RequestUsage, UsageLimits

from pydantic_ai_trace import Failed, Run, Trajectory
from pydantic_ai_trace.trajectory import Outcome, RunId

OUT = Path(__file__).parent / "traces"
T0 = datetime(2026, 10, 14, 9, 30, tzinfo=UTC)
ID_NAMESPACE = uuid.UUID("6f1c2b1e-8a4e-4d4b-9f0e-2c7d3a5b9e10")

Messages = list[dict[str, Any]]


def finish(
    messages: list[ModelMessage],
    *,
    name: str,
    start: datetime,
    model: str,
    provider: str,
    tool_durations: Mapping[str, timedelta] | None = None,
) -> Messages:
    """Give messages realistic timing and usage, and stable IDs derived from `name`.

    `tool_durations` holds, by stable tool call ID, how long a call takes at least, such as
    the subagent run it starts; its result arrives only after that.
    """
    durations = tool_durations or {}
    rng = random.Random(name)
    t = start
    input_tokens = 800
    timed: list[ModelMessage] = []
    tool_time = timedelta()
    stable = _stable_ids(ModelMessagesTypeAdapter.dump_python(messages, mode="json"), name)
    for message in ModelMessagesTypeAdapter.validate_python(stable):
        if isinstance(message, ModelResponse):
            t += timedelta(seconds=round(rng.uniform(0.8, 9.0), 3))
            input_tokens += rng.randint(200, 3000)
            calls_tool = any(isinstance(p, ToolCallPart) for p in message.parts)
            message = replace(
                message,
                timestamp=t,
                model_name=model,
                provider_name=provider,
                usage=RequestUsage(
                    input_tokens=input_tokens,
                    output_tokens=rng.randint(40, 900),
                    cache_read_tokens=input_tokens // 2 if provider == "anthropic" else 0,
                ),
                finish_reason="tool_call" if calls_tool else "stop",
                provider_response_id=f"resp_{rng.randrange(16**12):012x}",
            )
            call_ids = [p.tool_call_id for p in message.parts if isinstance(p, ToolCallPart)]
            tool_time = max((durations.get(i, timedelta()) for i in call_ids), default=timedelta())
        else:
            t += tool_time + timedelta(milliseconds=rng.randint(5, 1500))
            tool_time = timedelta()
            parts = [
                replace(p, timestamp=t) if hasattr(p, "timestamp") else p for p in message.parts
            ]
            message = replace(message, timestamp=t, parts=parts)
        timed.append(message)
    return ModelMessagesTypeAdapter.dump_python(timed, mode="json")


def _stable_ids(data: Messages, name: str) -> Messages:
    tool_call_ids: dict[str, str] = {}

    def visit(value: Any) -> Any:
        if isinstance(value, list):
            return [visit(item) for item in value]
        if not isinstance(value, dict):
            return value
        out = {key: visit(item) for key, item in value.items()}
        if out.get("run_id"):
            out["run_id"] = str(uuid.uuid5(ID_NAMESPACE, f"{name}/run"))
        if out.get("conversation_id"):
            out["conversation_id"] = str(uuid.uuid5(ID_NAMESPACE, f"{name}/conversation"))
        tool_call_id = out.get("tool_call_id")
        if isinstance(tool_call_id, str) and tool_call_id.startswith("pyd_ai_"):
            out["tool_call_id"] = tool_call_ids.setdefault(
                tool_call_id, f"call_{len(tool_call_ids) + 1}"
            )
        return out

    return visit(data)


def write_messages(path: Path, messages: Messages) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    validated = ModelMessagesTypeAdapter.validate_python(messages)
    path.write_bytes(ModelMessagesTypeAdapter.dump_json(validated, indent=2) + b"\n")


def steps(messages: list[ModelMessage]) -> int:
    return sum(isinstance(m, ModelResponse) for m in messages)


def png(width: int = 64, height: int = 48) -> bytes:
    rows = (
        b"\x00" + bytes(v for x in range(width) for v in (x * 4 % 256, y * 5 % 256, 140))
        for y in range(height)
    )

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


# Support agent: parallel tool calls, a retry, and structured output.


class Resolution(BaseModel):
    category: str
    refund_eur: float | None
    reply_to_customer: str
    escalate: bool


REPLY = (
    "Hi Jana,\n\nSorry your **Sonos Era 100** arrived damaged. I've refunded **€249.00** to your"
    " Visa ending 4242; it should appear within 3 to 5 business days.\n\nYou don't need to return"
    " the speaker.\n\nBest,\nSupport"
)


def support_model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    match steps(messages):
        case 0:
            return ModelResponse(
                parts=[
                    ThinkingPart(
                        "The customer says order #A-1043 arrived damaged. I should look up the"
                        " order first, then check the refund policy."
                    ),
                    ToolCallPart("lookup_order", {"order_id": "A-1043"}),
                    ToolCallPart("get_customer", {"email": "jana.novak@example.com"}),
                ]
            )
        case 1:
            args = {"category": "electronics", "days_since_delivery": 3}
            return ModelResponse(parts=[ToolCallPart("refund_policy", args)])
        case 2:
            args = {"category": "Electronics", "days_since_delivery": 3}
            return ModelResponse(parts=[ToolCallPart("refund_policy", args)])
        case 3:
            args = {"order_id": "A-1043", "amount_eur": 249.0, "reason": "damaged in transit"}
            return ModelResponse(parts=[ToolCallPart("issue_refund", args)])
        case _:
            output = {
                "category": "damaged_item",
                "refund_eur": 249.0,
                "reply_to_customer": REPLY,
                "escalate": False,
            }
            return ModelResponse(
                parts=[
                    TextPart("I've issued the refund and drafted a reply."),
                    ToolCallPart(info.output_tools[0].name, output),
                ]
            )


def support_agent() -> Agent[None, Resolution]:
    agent = Agent(
        FunctionModel(support_model),
        output_type=Resolution,
        instructions=(
            "You are a support agent for an electronics shop. Be concise. Always check the refund"
            " policy before issuing a refund. Never refund more than the order total."
        ),
    )

    @agent.tool_plain
    def lookup_order(order_id: str) -> dict[str, Any]:
        """Look up an order by ID."""
        return {
            "order_id": order_id,
            "status": "delivered",
            "delivered_at": "2026-10-11",
            "total_eur": 249.0,
            "items": [{"sku": "SONOS-ERA100-BLK", "name": "Sonos Era 100", "qty": 1}],
            "shipping": {
                "carrier": "DHL",
                "tracking": "JD0000000000000000",
                "address": {"street": "Musterstraße 1", "city": "Berlin", "zip": "10115"},
            },
        }

    @agent.tool_plain
    def get_customer(email: str) -> dict[str, Any]:
        """Fetch the customer profile."""
        return {"id": 88123, "name": "Jana Novák", "email": email, "tier": "gold", "orders": 14}

    @agent.tool_plain
    def refund_policy(category: str, days_since_delivery: int) -> str:
        """Return the refund policy for a product category."""
        if category != category.capitalize():
            raise ModelRetry(
                f"Unknown category {category!r}. Valid categories: Electronics, Home, Garden."
                " Category names are case-sensitive."
            )
        return (
            f"Damaged items: full refund within 30 days of delivery ({days_since_delivery} so far)."
        )

    @agent.tool_plain
    def issue_refund(order_id: str, amount_eur: float, reason: str) -> dict[str, Any]:
        """Issue a refund."""
        return {"refund_id": "rf_9Q2x", "order_id": order_id, "amount_eur": amount_eur}

    return agent


# Multi-turn chat: three runs sharing one message history.

CHAT_REPLIES = [
    "Thanks for reaching out! Could you share your order number?",
    "Got it, order **A-1043**. I can see it was delivered on Oct 11. What's wrong with it?",
    "I'm sorry to hear that. I've opened a ticket and someone will follow up within 24 hours.",
]


def chat() -> list[ModelMessage]:
    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(CHAT_REPLIES[min(steps(messages), 2)])])

    agent = Agent(FunctionModel(model), system_prompt="You are a friendly shop assistant.")
    history: list[ModelMessage] = []
    for prompt in ["hi", "it's A-1043", "the speaker grille is cracked"]:
        history = agent.run_sync(prompt, message_history=history).all_messages()
    return history


# Coding agent: shell output, file contents, and a Markdown summary.

PY_FILE = "\n".join(
    [
        "from __future__ import annotations",
        "",
        "import asyncio",
        "import logging",
        "",
        "logger = logging.getLogger(__name__)",
        "",
        *(
            f"def handler_{i}(request: dict) -> dict:\n"
            f'    """Handle request type {i}."""\n'
            "    logger.info('handling %s', request)\n"
            f"    return {{'ok': True, 'n': {i}}}\n"
            for i in range(120)
        ),
    ]
)

PYTEST_FAILURE = """\
============================= test session starts ==============================
platform darwin -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0
rootdir: /repo
collected 214 items

tests/test_api.py ........................................................ [ 26%]
tests/test_handlers.py ...........F.......................................... [ 51%]
tests/test_models.py ....................................................... [ 77%]
tests/test_utils.py ................................................         [100%]

=================================== FAILURES ===================================
_________________________ test_handler_retries_on_429 __________________________

    def test_handler_retries_on_429(httpx_mock):
        httpx_mock.add_response(status_code=429)
        httpx_mock.add_response(json={"ok": True})
>       assert handler_42({"url": "https://api.example.test"}) == {"ok": True, "n": 42}
E       AssertionError: assert {'ok': False, 'error': 'rate limited'} == {'ok': True, 'n': 42}

tests/test_handlers.py:118: AssertionError
=========================== short test summary info ============================
FAILED tests/test_handlers.py::test_handler_retries_on_429 - AssertionError
======================== 1 failed, 213 passed in 4.21s ========================="""

RETRY_LOOP = (
    "for attempt in range(3):\n"
    "        resp = client.get(request['url'])\n"
    "        if resp.status_code != 429:\n"
    "            break\n"
    "        await asyncio.sleep(2 ** attempt)\n"
    "    return {'ok': True, 'n': 42}"
)

CODER_PLAN: list[tuple[str, dict[str, Any]]] = [
    ("run_shell", {"cmd": "rg -n 'def handler_42' -A 20"}),
    ("read_file", {"path": "src/app/handlers.py"}),
    ("run_shell", {"cmd": "pixi run pytest -x -q"}),
    ("read_file", {"path": "tests/test_handlers.py", "start_line": 100, "end_line": 140}),
    (
        "edit_file",
        {"path": "src/app/handlers.py", "old": "return {'ok': True, 'n': 42}", "new": RETRY_LOOP},
    ),
    ("run_shell", {"cmd": "pixi run pytest tests/test_handlers.py -q"}),
    ("run_shell", {"cmd": "git diff --stat"}),
]

CODER_SUMMARY = """\
## Fixed: `handler_42` now retries on 429

The handler returned immediately on a rate-limit response. I added exponential backoff with \
three attempts.

| File | Change |
|---|---|
| `src/app/handlers.py` | retry loop with backoff |

```diff
-    return {'ok': True, 'n': 42}
+    for attempt in range(3):
+        resp = client.get(request['url'])
+        if resp.status_code != 429:
+            break
+        await asyncio.sleep(2 ** attempt)
```

All 214 tests pass. One thing to check: `asyncio.sleep` inside a sync function. I left a TODO, \
since the handler should probably become `async`."""


def coder_model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    step = steps(messages)
    if step >= len(CODER_PLAN):
        return ModelResponse(parts=[TextPart(CODER_SUMMARY)])
    name, args = CODER_PLAN[step]
    parts: list[ThinkingPart | TextPart | ToolCallPart] = []
    if step in (0, 2, 4):
        reasoning = "I need to understand why the retry path is not taken. " * 6
        parts.append(ThinkingPart(f"Step {step}: {reasoning.strip()}"))
    if step == 3:
        parts.append(TextPart("The test expects a retry on HTTP 429. Let me look at the test."))
    parts.append(ToolCallPart(name, args))
    return ModelResponse(parts=parts)


def coder() -> list[ModelMessage]:
    agent = Agent(
        FunctionModel(coder_model),
        instructions=(
            "You are a coding agent working in /repo. Use tools to inspect and edit code."
            " Run the tests before finishing."
        ),
    )

    @agent.tool_plain
    def run_shell(cmd: str) -> str:
        """Run a shell command."""
        if "pytest -x" in cmd:
            return PYTEST_FAILURE
        if "pytest" in cmd:
            return "214 passed in 4.02s"
        if "diff" in cmd:
            return (
                " src/app/handlers.py | 6 +++++-\n 1 file changed, 5 insertions(+), 1 deletion(-)"
            )
        matches = (f"src/app/handlers.py:{300 + i}-    line {i}" for i in range(1, 21))
        return "src/app/handlers.py:300:def handler_42(request: dict) -> dict:\n" + "\n".join(
            matches
        )

    @agent.tool_plain
    def read_file(path: str, start_line: int | None = None, end_line: int | None = None) -> str:
        """Read a file."""
        return PY_FILE

    @agent.tool_plain
    def edit_file(path: str, old: str, new: str) -> str:
        """Replace text in a file."""
        return f"Edited {path}: 1 replacement"

    prompt = "tests/test_handlers.py::test_handler_retries_on_429 fails. Fix it."
    return agent.run_sync(prompt).all_messages()


# Research trajectory: an orchestrator, nested subagents, and a failed run.

BRIEF = """\
# EU heat-pump market brief

- **Market size 2025:** ~€14.6bn (est.)
- **Top vendors (DE):** Viessmann, Vaillant, Bosch, Daikin, Stiebel Eltron

_The fact-check subagent failed; treat the market size as unverified._"""

FINDINGS = {
    "market_researcher": "€14.6bn in 2025 (EHPA estimate)",
    "competitor_researcher": "Viessmann 18%, Vaillant 16%, Bosch 14%, Daikin 11%, Stiebel 9%",
}


def orchestrator_model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
    match steps(messages):
        case 0:
            return ModelResponse(
                parts=[
                    TextPart("I'll split this into market sizing and competitor research."),
                    ToolCallPart(
                        "delegate",
                        {
                            "agent": "market_researcher",
                            "task": "Estimate the EU heat-pump market size for 2025.",
                        },
                        tool_call_id="call_market",
                    ),
                    ToolCallPart(
                        "delegate",
                        {
                            "agent": "competitor_researcher",
                            "task": "List the top 5 heat-pump vendors in Germany by share.",
                        },
                        tool_call_id="call_competitors",
                    ),
                ]
            )
        case 1:
            args = {"agent": "fact_checker", "task": "Verify the market size figure."}
            return ModelResponse(parts=[ToolCallPart("delegate", args, tool_call_id="call_fact")])
        case _:
            return ModelResponse(parts=[TextPart(BRIEF)])


def orchestrator() -> list[ModelMessage]:
    agent = Agent(
        FunctionModel(orchestrator_model),
        instructions="You coordinate research subagents and write a one-page brief.",
    )

    @agent.tool_plain
    def delegate(agent: str, task: str) -> str:
        """Delegate a task to a subagent."""
        return FINDINGS.get(agent, f"ERROR: subagent {agent!r} failed on {task!r}")

    return agent.run_sync("Write a brief on the EU heat-pump market.").all_messages()


def researcher(prompt: str, queries: list[str], answer: str) -> list[ModelMessage]:
    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        step = steps(messages)
        if step < len(queries):
            return ModelResponse(parts=[ToolCallPart("web_search", {"query": queries[step]})])
        return ModelResponse(parts=[TextPart(answer)])

    agent = Agent(FunctionModel(model), instructions="You research using web search. Cite sources.")

    @agent.tool_plain
    def web_search(query: str) -> list[dict[str, str]]:
        """Search the web."""
        snippet = "Heat pump sales in Europe fell 21% in 2024 after record years."
        return [
            {
                "title": f"Result {i}: {query}",
                "url": f"https://example.test/{i}",
                "snippet": snippet,
            }
            for i in range(8)
        ]

    return agent.run_sync(prompt).all_messages()


@dataclass(frozen=True)
class RunSpec:
    """A scripted run and the subagents its tool calls start, keyed by stable tool call ID."""

    name: str
    messages: list[ModelMessage]
    model: str
    provider: str
    outcome: Outcome | None = None
    subagents: dict[str, RunSpec] = field(default_factory=dict)


def timed_runs(
    spec: RunSpec, start: datetime, parent: Run | None = None, tool_call_id: str | None = None
) -> list[Run]:
    """The run and its subagents, each starting after its tool call and ending before its result."""
    durations = {call_id: duration(sub) for call_id, sub in spec.subagents.items()}
    data = finish(
        spec.messages,
        name=spec.name,
        start=start,
        model=spec.model,
        provider=spec.provider,
        tool_durations=durations,
    )
    run = Run.from_messages(
        data,
        name=spec.name,
        parent=parent,
        tool_call_id=tool_call_id,
        outcome=spec.outcome,
        id=RunId(str(uuid.uuid5(ID_NAMESPACE, spec.name))),
    )
    runs = [run]
    for call_id, sub in spec.subagents.items():
        runs += timed_runs(sub, called_at(run, call_id), run, call_id)
    return runs


def duration(spec: RunSpec) -> timedelta:
    """From the given start to the run's end; timing depends only on the spec."""
    return timed_runs(spec, T0)[0].ended_at - T0


def called_at(run: Run, tool_call_id: str) -> datetime:
    return next(
        message.timestamp
        for message in run.messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, ToolCallPart) and part.tool_call_id == tool_call_id
    )


def research_trajectory() -> Trajectory:
    pdf_finder = RunSpec(
        "pdf_finder",
        researcher("Find the EHPA 2025 report PDF.", ["EHPA 2025 report pdf"], "Found it."),
        "gpt-5-nano",
        "openai",
    )
    market = RunSpec(
        "market_researcher",
        researcher(
            "Estimate the EU heat-pump market size for 2025.",
            ["EU heat pump market size 2025", "EHPA market report 2025"],
            FINDINGS["market_researcher"],
        ),
        "gpt-5-mini",
        "openai",
        subagents={"call_1": pdf_finder},
    )
    competitors = RunSpec(
        "competitor_researcher",
        researcher(
            "List the top 5 heat-pump vendors in Germany by share.",
            ["heat pump market share Germany 2025"],
            FINDINGS["competitor_researcher"],
        ),
        "gpt-5-mini",
        "openai",
    )
    fact_checker = RunSpec(
        "fact_checker",
        researcher("Verify the market size figure.", ["EHPA 2025 heat pump"], "Unverified.")[:3],
        "gpt-5-mini",
        "openai",
        outcome=Failed(
            error_type="UsageLimitExceeded",
            detail="The next request would exceed the request_limit of 3",
        ),
    )
    root = RunSpec(
        "orchestrator",
        orchestrator(),
        "claude-sonnet-4-5",
        "anthropic",
        subagents={
            "call_market": market,
            "call_competitors": competitors,
            "call_fact": fact_checker,
        },
    )
    runs = timed_runs(root, T0)
    return Trajectory(runs=tuple(sorted(runs, key=lambda run: run.ended_at)))


# Multimodal input: inline image, image URL, and document URL.


def multimodal() -> list[ModelMessage]:
    answer = (
        "The receipt shows **3 items** totalling **€42.17**, dated 12 Oct 2026."
        " The invoice matches."
    )

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(answer)])

    agent = Agent(FunctionModel(model), instructions="Extract expense data from receipts.")
    prompt = [
        "Here is my receipt and the invoice. Do they match?",
        BinaryContent(data=png(), media_type="image/png", identifier="receipt.png"),
        ImageUrl(url="https://example.test/receipts/2026-10-12.png"),
        DocumentUrl(url="https://example.test/invoice-2026-10.pdf"),
    ]
    return agent.run_sync(prompt).all_messages()


# Long run: 150 tool-calling steps.


def batch() -> list[ModelMessage]:
    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        step = steps(messages)
        if step < 150:
            args = {"offset": step * 100, "limit": 100}
            return ModelResponse(
                parts=[
                    ThinkingPart(f"Batch {step}: checking postcodes."),
                    ToolCallPart("fetch_rows", args),
                ]
            )
        return ModelResponse(parts=[TextPart("Processed 15,000 rows; 37 had invalid postcodes.")])

    agent = Agent(FunctionModel(model), instructions="Validate the customer table in batches.")
    rng = random.Random("batch")

    @agent.tool_plain
    def fetch_rows(offset: int, limit: int) -> list[dict[str, Any]]:
        """Fetch rows."""
        return [{"id": offset + i, "postcode": f"{rng.randint(10000, 99999)}"} for i in range(10)]

    limits = UsageLimits(request_limit=200)
    return agent.run_sync("Validate the customers table.", usage_limits=limits).all_messages()


# Eval dataset: one short run per JSONL line.

EVAL_CASES = [
    ("What is the capital of Australia?", "Canberra."),
    ("Translate 'good morning' to Japanese.", "おはようございます (ohayō gozaimasu)"),
    ("Sum the numbers 1 to 100.", "5050"),
    ("Who wrote 'Der Process'?", "Franz Kafka."),
    ("Convert 72°F to Celsius.", "22.2 °C"),
]


def eval_jsonl() -> str:
    lines = []
    for i in range(40):
        question, answer = EVAL_CASES[i % len(EVAL_CASES)]

        def model(
            messages: list[ModelMessage], info: AgentInfo, answer: str = answer
        ) -> ModelResponse:
            return ModelResponse(parts=[TextPart(answer)])

        agent = Agent(FunctionModel(model), instructions="Answer briefly.")
        messages = finish(
            agent.run_sync(question).all_messages(),
            name=f"eval-{i}",
            start=T0 + timedelta(minutes=i),
            model="gpt-5-nano",
            provider="openai",
        )
        validated = ModelMessagesTypeAdapter.validate_python(messages)
        lines.append(ModelMessagesTypeAdapter.dump_json(validated).decode())
    return "\n".join(lines) + "\n"


# Text that stresses rendering: scripts, long URLs, wide tables, and HTML.


def i18n() -> list[ModelMessage]:
    columns = range(18)
    text = (
        "Here's the summary in three languages:\n\n"
        "- 🇩🇪 Die Lieferung kommt **morgen** an.\n"
        "- 🇯🇵 配達は明日到着します。\n"
        "- 🇸🇦 سيصل التسليم غدًا.\n\n"
        f"A very long URL: https://example.test/{'a' * 400}\n\n"
        "A wide table:\n\n"
        f"| {' | '.join(f'col{i}' for i in columns)} |\n"
        f"|{'---|' * len(columns)}\n"
        f"| {' | '.join(str(i * 1000) for i in columns)} |\n\n"
        "Inline HTML that must not render: <script>alert('xss')</script>"
        " <img src=x onerror=alert(1)>\n\n"
        "$$E = mc^2$$"
    )

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(text)])

    agent = Agent(FunctionModel(model), instructions="Summarize.")
    prompt = "Summarize the delivery status for our DE, JP, and SA customers."
    return agent.run_sync(prompt).all_messages()


def main() -> None:
    def write(path: str, messages: list[ModelMessage], model: str, provider: str) -> None:
        data = finish(messages, name=path, start=T0, model=model, provider=provider)
        write_messages(OUT / path, data)

    support = support_agent().run_sync(
        "Hi, my order A-1043 arrived with a cracked speaker grille. I'd like a refund please."
    )
    write("support/refund-A-1043.json", support.all_messages(), "gpt-5", "openai")
    write("support/chat with history.json", chat(), "claude-haiku-4-5", "anthropic")
    write("coding/fix-429-retry.json", coder(), "claude-sonnet-4-5", "anthropic")
    write("multimodal/receipt.json", multimodal(), "gpt-5", "openai")
    write("batch/validate-customers.json", batch(), "gpt-5-mini", "openai")
    write("i18n/überblick-配達.json", i18n(), "local-llama", "ollama")
    (OUT / "research").mkdir(parents=True, exist_ok=True)
    trajectory = research_trajectory().model_dump_json(indent=2)
    (OUT / "research" / "heat-pump-brief.json").write_text(trajectory + "\n", encoding="utf-8")
    (OUT / "evals").mkdir(parents=True, exist_ok=True)
    (OUT / "evals" / "qa-eval.jsonl").write_text(eval_jsonl(), encoding="utf-8")


if __name__ == "__main__":
    main()
