"""Token-efficient plain-text transcript of a trajectory.

Messages are rendered from their canonical Pydantic AI JSON dump, the same shape the
browser viewer reads, in the same message and part order.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from pydantic_ai.messages import BaseToolCallPart, ModelMessagesTypeAdapter

from ._format import format_bytes, format_count, format_duration, format_usd
from .analysis import Analysis, RunAnalysis, Totals, parse_tool_args
from .trajectory import Run, RunId, Trajectory

CAPABILITY_LOAD_KIND = "capability-load"
TOOL_SEARCH_KIND = "tool-search"
COMPACTION_PLACEHOLDER = "[History compacted by the provider; no readable summary.]"


def format_transcript(trajectory: Trajectory, analysis: Analysis, name: str) -> str:
    """Render every run in tree order.

    A one-run trajectory has no run heading; its parent and an unsuccessful outcome
    move into the trace details instead, so diagnostics are never dropped.
    """
    by_id = {run.run_id: run for run in analysis.runs}
    runs = {run.id: run for run in trajectory.runs}
    ordered = [run for run, _ in trajectory.walk()]
    details = [f"NAME: {_inline(name)}", _totals(analysis.totals)]
    if len(ordered) == 1:
        [run] = ordered
        details.extend(_parent_lines(run, runs, by_id))
        if run.outcome.status != "completed":
            details.append(_outcome_line(run))
    sections = [_section(_envelope("TRACE"), "\n".join(details))]
    for run in ordered:
        if len(ordered) > 1:
            sections.append(
                _section(
                    _envelope(f"RUN: {_inline(run.name)}"),
                    _run_details(run, by_id[run.id], runs, by_id),
                )
            )
        sections.extend(_message_sections(run, by_id[run.id], runs))
    return "\n\n".join(sections) + "\n"


def _run_details(
    run: Run,
    analysis: RunAnalysis,
    runs: Mapping[RunId, Run],
    analyses: Mapping[RunId, RunAnalysis],
) -> str:
    lines = [
        f"ID: {run.id}",
        *_parent_lines(run, runs, analyses),
        _outcome_line(run),
        _totals(analysis.totals),
    ]
    return "\n".join(lines)


def _parent_lines(
    run: Run,
    runs: Mapping[RunId, Run],
    analyses: Mapping[RunId, RunAnalysis],
) -> list[str]:
    """The parent, named by the run and the response and tool call that started this run."""
    if run.parent is None:
        return []
    parent = runs.get(run.parent.run_id)
    if parent is None:
        via = f" via tool call {run.parent.tool_call_id}" if run.parent.tool_call_id else ""
        return [f"PARENT: {run.parent.run_id} (not recorded){via}"]
    line = f"PARENT: {_inline(parent.name)} ({parent.id})"
    parent_analysis = analyses[parent.id]
    call = next((info for info in parent_analysis.tool_calls if run.id in info.child_run_ids), None)
    if call is None:
        return [line]
    response = [info.message for info in parent_analysis.responses].index(call.call.message) + 1
    part = parent.messages[call.call.message].parts[call.call.part]
    assert isinstance(part, BaseToolCallPart)
    tool = f"{_tool_call_label(part.part_kind)}: {_inline(part.tool_name)}"
    return [f"{line} · RESPONSE {response} · {tool}"]


def _outcome_line(run: Run) -> str:
    outcome = run.outcome
    if outcome.status == "failed":
        return f"OUTCOME: failed · {_inline(outcome.error_type)}: {_inline(outcome.detail)}"
    return f"OUTCOME: {outcome.status}"


def _totals(totals: Totals) -> str:
    tokens = totals.tokens
    summary = [
        f"LLM CALLS: {format_count(totals.llm_calls)}",
        f"TOKENS: {_token_usage(tokens.input, tokens.output, tokens.cache_read)}",
    ]
    if totals.cost_usd is not None:
        unpriced = f" (+{totals.unpriced_calls} unpriced)" if totals.unpriced_calls else ""
        summary.append(f"COST: {format_usd(totals.cost_usd)}{unpriced}")
    summary.append(f"WALL TIME: {format_duration(totals.duration_seconds)}")
    return " | ".join(summary)


def _message_sections(run: Run, analysis: RunAnalysis, runs: Mapping[RunId, Run]) -> list[str]:
    messages: list[dict[str, Any]] = ModelMessagesTypeAdapter.dump_python(
        list(run.messages), mode="json"
    )
    costs = {response.message: response.cost_usd for response in analysis.responses}
    outputs = [info for info in analysis.tool_calls if info.is_output]
    output_calls = {(info.call.message, info.call.part) for info in outputs}
    output_returns = {(info.result.message, info.result.part) for info in outputs if info.result}
    started = {
        (info.call.message, info.call.part): info.child_run_ids for info in analysis.tool_calls
    }
    sections: list[str] = []
    request_number = 0
    response_number = 0
    for index, (message, instructions) in enumerate(
        zip(messages, changed_instructions(messages), strict=True)
    ):
        parts: list[str] = []
        if instructions is not None:
            parts.append(_part_section("INSTRUCTIONS", _js_string(instructions)))
        for part_index, part in enumerate(message["parts"]):
            position = (index, part_index)
            if position in output_calls:
                formatted = _format_output_call(part)
            elif position in output_returns:
                formatted = _format_output_return(part)
            else:
                formatted = _format_part(part)
            child_ids = started.get(position, ())
            # Recorded children only; the child's PARENT line points back here.
            formatted += "".join(
                f"\n\nSTARTED RUN: {_inline(runs[child].name)} ({child})"
                for child in child_ids
                if child in runs
            )
            if formatted:
                parts.append(formatted)

        if message["kind"] == "response":
            response_number += 1
            heading = _response_envelope(message, response_number, costs.get(index))
        else:
            request_number += 1
            heading = _request_envelope(message.get("state"), request_number)
        sections.append(_section(heading, "\n\n".join(parts)))
    return sections


def changed_instructions(messages: list[dict[str, Any]]) -> list[object | None]:
    """Each request's instructions when they differ from the last shown, else None."""
    changed: list[object | None] = []
    last: object = None
    for message in messages:
        instructions = message.get("instructions")
        if message["kind"] == "request" and instructions and instructions != last:
            last = instructions
            changed.append(instructions)
        else:
            changed.append(None)
    return changed


def _request_envelope(state: object, number: int) -> str:
    return _envelope(f"REQUEST {number}{_state_label(state)}")


def _response_envelope(response: dict[str, Any], number: int, cost_usd: Decimal | None) -> str:
    details = [f"RESPONSE {number}{_state_label(response.get('state'))}"]
    if response.get("model_name"):
        details.append(_inline(response["model_name"]))
    usage = response["usage"]
    details.append(
        _token_usage(usage["input_tokens"], usage["output_tokens"], usage["cache_read_tokens"])
    )
    if cost_usd is not None:
        details.append(format_usd(cost_usd))
    return _envelope(" · ".join(details))


def _state_label(state: object) -> str:
    return f" [{_inline(state).upper()}]" if state and state != "complete" else ""


def _token_usage(input_tokens: int, output_tokens: int, cached_tokens: int) -> str:
    cached = f" ({format_count(cached_tokens)} cached)" if cached_tokens > 0 else ""
    return f"{format_count(input_tokens)} in{cached} → {format_count(output_tokens)} out"


def _format_part(part: dict[str, Any]) -> str:
    kind = part["part_kind"]
    if kind == "system-prompt":
        return _part_section("SYSTEM PROMPT", _js_string(part.get("content")))
    if kind == "user-prompt":
        return _part_section("USER PROMPT", _format_user_content(part.get("content")))
    if kind == "text":
        return _part_section("TEXT", _js_string(part.get("content")))
    if kind == "thinking":
        return _part_section("THINKING", _js_string(part["content"])) if part.get("content") else ""
    if kind in {"tool-call", "builtin-tool-call"}:
        return _format_tool_call(part)
    if kind in {"tool-return", "builtin-tool-return"}:
        return _format_tool_return(part)
    if kind == "retry-prompt":
        return _format_retry_prompt(part)
    if kind == "compaction":
        content = part.get("content")
        return _part_section(
            "COMPACTION", _js_string(content) if content else COMPACTION_PLACEHOLDER
        )
    if kind == "file":
        return _part_section("FILE", _format_file(part.get("content")))
    if kind == "tool-availability-delta":
        return _format_tool_availability_delta(part)
    return _part_section(f"UNKNOWN PART: {_inline(kind)}", _json(part))


def _tool_call_label(part_kind: str) -> str:
    return "BUILTIN TOOL CALL" if part_kind == "builtin-tool-call" else "TOOL CALL"


def _format_tool_call(part: dict[str, Any]) -> str:
    kind = _tool_call_label(part["part_kind"])
    tool_kind = f" [{_inline(part['tool_kind']).upper()}]" if part.get("tool_kind") else ""
    return _part_section(
        f"{kind}: {_inline(part.get('tool_name'))}{tool_kind}",
        _format_tool_call_args(part),
    )


def _format_output_call(part: dict[str, Any]) -> str:
    """The call whose arguments are the run's output; see `FINAL_RESULT_STATUS`."""
    return _part_section(
        f"OUTPUT: {_inline(part.get('tool_name'))}",
        _format_value(parse_tool_args(part.get("args"))),
    )


def _format_output_return(part: dict[str, Any]) -> str:
    """Pydantic AI's fixed status reply to the output call; its heading says enough."""
    return f"--- OUTPUT ACCEPTED: {_inline(part.get('tool_name'))} ---"


def _format_tool_call_args(part: dict[str, Any]) -> str:
    """Framework-emitted tool calls carry a typed payload worth naming; see `_tool_search`."""
    queries = _tool_search_queries(part)
    if queries is not None:
        return "QUERIES:\n" + "\n".join(queries)
    capability = _capability_id(part)
    if capability is not None:
        return f"CAPABILITY: {capability}"
    return f"ARGUMENTS:\n{_format_value(parse_tool_args(part.get('args')))}"


def _format_tool_return(part: dict[str, Any]) -> str:
    kind = "BUILTIN TOOL RETURN" if part["part_kind"] == "builtin-tool-return" else "TOOL RETURN"
    tool_kind = f" [{_inline(part['tool_kind']).upper()}]" if part.get("tool_kind") else ""
    outcome = part.get("outcome")
    outcome_label = f" [{outcome.upper()}]" if outcome in {"failed", "denied"} else ""
    return _part_section(
        f"{kind}: {_inline(part.get('tool_name'))}{tool_kind}{outcome_label}",
        _format_tool_return_content(part),
    )


def _format_tool_return_content(part: dict[str, Any]) -> str:
    discovered = discovered_tools(part)
    if discovered is not None:
        content = part["content"]
        message = content.get("message")
        body = f"DISCOVERED TOOLS: {', '.join(discovered) if discovered else 'none'}"
        return f"{body}\n\n{message}" if isinstance(message, str) and message else body
    instructions = _capability_instructions(part)
    if instructions is not None:
        return instructions
    return _format_value(part.get("content"))


def _format_tool_availability_delta(part: dict[str, Any]) -> str:
    added = part["tools_added"]
    body = "\n".join(f"+{name}" for name in added) if added else _json(part)
    return _part_section("TOOL AVAILABILITY", body)


def _format_retry_prompt(part: dict[str, Any]) -> str:
    tool = f": {_inline(part['tool_name'])}" if part.get("tool_name") else ""
    return _part_section(f"RETRY PROMPT{tool}", _format_value(part.get("content")))


def _tool_search_queries(part: dict[str, Any]) -> list[str] | None:
    """Queries of a tool-search call, or None when the part is not one."""
    if part.get("tool_kind") != TOOL_SEARCH_KIND:
        return None
    args = parse_tool_args(part.get("args"))
    queries = args.get("queries") if isinstance(args, dict) else None
    if not isinstance(queries, list):
        return None
    return [query for query in queries if isinstance(query, str)]


def discovered_tools(part: dict[str, Any]) -> list[str] | None:
    """Tool names a tool-search return revealed, or None when the part is not one."""
    if part.get("tool_kind") != TOOL_SEARCH_KIND:
        return None
    content = part.get("content")
    if not isinstance(content, dict) or not isinstance(content.get("discovered_tools"), list):
        return None
    return [
        match["name"]
        for match in content["discovered_tools"]
        if isinstance(match, dict) and isinstance(match.get("name"), str)
    ]


def _capability_id(part: dict[str, Any]) -> str | None:
    if part.get("tool_kind") != CAPABILITY_LOAD_KIND:
        return None
    args = parse_tool_args(part.get("args"))
    capability = args.get("id") if isinstance(args, dict) else None
    return capability if isinstance(capability, str) else None


def _capability_instructions(part: dict[str, Any]) -> str | None:
    if part.get("tool_kind") != CAPABILITY_LOAD_KIND:
        return None
    content = part.get("content")
    if not isinstance(content, dict) or not isinstance(content.get("instructions"), str):
        return None
    return content["instructions"]


def _format_user_content(content: object) -> str:
    items = content if isinstance(content, list) else [content]
    return "\n\n".join(_format_user_item(item) for item in items)


def _format_user_item(item: object) -> str:
    if isinstance(item, str):
        return item
    if not isinstance(item, dict):
        return _json(item)
    if item.get("kind") == "text-content":
        return _js_string(item.get("content"))
    if item.get("kind") == "uploaded-file":
        return "[uploaded file]"
    if item.get("kind") == "cache-point":
        return "[cache point]"
    if is_media(item):
        return _format_media(item)
    return _json(item)


def _format_file(content: object) -> str:
    return _format_media(content) if is_media(content) else _json(content)


def _format_value(value: object) -> str:
    if isinstance(value, str):
        return value
    if is_media(value):
        return _format_media(value)
    if isinstance(value, list) and any(is_media(item) for item in value):
        return "\n\n".join(
            _format_media(item) if is_media(item) else _format_value(item) for item in value
        )
    return "\n".join(_outline(value))


def _outline(value: object) -> list[str]:
    """A structured value as one `key: value` line per scalar, nested by indentation.

    Scalars are JSON literals, so strings stay quoted and unambiguous; a string with a
    line break becomes a `|` block of its lines, indented under its key.
    """
    if is_media(value):
        return [_format_media(value)]
    if isinstance(value, dict) and value:
        return [line for key, child in value.items() for line in _entry(f"{_key(key)}:", child)]
    if isinstance(value, list) and value:
        return [line for item in value for line in _entry("-", item)]
    return [_json(value)]


def _entry(head: str, value: object) -> list[str]:
    if isinstance(value, str) and "\n" in value:
        return [f"{head} |", *_indent(value.split("\n"))]
    lines = _outline(value)
    if not isinstance(value, dict | list) or not value or is_media(value):
        return [f"{head} {lines[0]}"]
    if head == "-":
        return [f"- {lines[0]}", *_indent(lines[1:])]
    return [head, *_indent(lines)]


def _indent(lines: list[str]) -> list[str]:
    return [f"  {line}" if line else "" for line in lines]


def _key(key: str) -> str:
    return key if re.fullmatch(r"[\w.-]+", key) else _json(key)


def is_media(value: object) -> bool:
    """A dumped `BinaryContent` or `*Url` item."""
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    if kind == "binary":
        return isinstance(value.get("data"), str)
    return isinstance(kind, str) and kind.endswith("-url") and isinstance(value.get("url"), str)


def _format_media(item: object) -> str:
    assert isinstance(item, dict)
    kind = _js_string(item.get("kind"))
    if kind == "binary":
        media_type = _js_string(item.get("media_type") or "application/octet-stream")
        size = base64_byte_length(_js_string(item.get("data")))
        # Pydantic AI defaults the identifier to a short hash of the data; the model
        # refers to the file by it.
        identifier = _js_string(item.get("identifier"))
        name = f"{identifier}, " if identifier else ""
        return f"[binary: {name}{media_type}, {format_bytes(size)}, payload omitted]"
    return f"[{kind.removesuffix('-url')}] {_js_string(item.get('url'))}"


def base64_byte_length(data: str) -> int:
    normalized = re.sub(r"\s", "", data)
    padding = 2 if normalized.endswith("==") else 1 if normalized.endswith("=") else 0
    return max(0, math.floor(len(normalized) * 3 / 4) - padding)


def _json(value: object) -> str:
    """Match JSON.stringify for values produced by parsing valid JSON."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        try:
            number = float(value) if abs(value) > 2**53 - 1 else value
        except OverflowError:
            return "null"
        return _js_number(number)
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, list):
        return f"[{','.join(_json(item) for item in value)}]"
    if isinstance(value, dict):
        fields = (f"{_json(str(key))}:{_json(child)}" for key, child in value.items())
        return f"{{{','.join(fields)}}}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _js_number(value: int | float) -> str:
    """Render the common JSON-number forms the way JavaScript JSON.stringify does."""
    if isinstance(value, float) and not math.isfinite(value):
        return "null"
    number = float(value)
    if number == 0:
        return "0"
    absolute = abs(number)
    shortest = repr(number)
    if 1e-6 <= absolute < 1e21:
        fixed = format(Decimal(shortest), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    coefficient, exponent = shortest.lower().split("e")
    coefficient = coefficient.removesuffix(".0")
    exponent_number = int(exponent)
    exponent_text = f"+{exponent_number}" if exponent_number >= 0 else str(exponent_number)
    return f"{coefficient}e{exponent_text}"


def _envelope(label: str) -> str:
    return f"========== {label} =========="


def _part_section(label: str, body: str) -> str:
    return _section(f"--- {label} ---", body)


def _section(heading: str, body: str) -> str:
    return f"{heading}\n\n{body}" if body else heading


def _inline(value: object) -> str:
    return re.sub(r"\s+", " ", _js_string(value)).strip()


def _js_string(value: object) -> str:
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, dict):
        return "[object Object]"
    if isinstance(value, list):
        return ",".join(_js_string(item) for item in value)
    return str(value)
