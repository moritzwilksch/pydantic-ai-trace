"""Token-efficient plain-text rendering for pydantic-ai trace dumps.

This module intentionally has no pydantic-ai dependency. Trace dumps are
untrusted, versioned wire data, so the formatter mirrors the frontend's
tolerant parsing and fallback behavior instead of validating a fixed schema.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime
from decimal import Decimal
from typing import Any


def format_trace_as_text(trace: object, name: str) -> str:
    """Render one trace in the same message/part order as the browser viewer."""
    messages = _parse_messages(trace)
    sections = [_section(_envelope("TRACE"), _trace_details(messages, name))]
    request_number = 0
    response_number = 0
    last_instructions: object = None

    for message in messages:
        if message["kind"] == "unknown":
            sections.append(_section(_envelope("UNKNOWN MESSAGE"), _json(message["raw"])))
            continue

        parts: list[str] = []
        instructions = message.get("instructions")
        if message["kind"] == "request" and instructions and instructions != last_instructions:
            parts.append(_part_section("INSTRUCTIONS", _js_string(instructions)))
            last_instructions = instructions
        for part in message["parts"]:
            formatted = _format_part(part)
            if formatted:
                parts.append(formatted)

        if message["kind"] == "response":
            response_number += 1
            heading = _response_envelope(message, response_number)
        else:
            request_number += 1
            heading = _request_envelope(message.get("state"), request_number)
        sections.append(_section(heading, "\n\n".join(parts)))

    return "\n\n".join(sections) + "\n"


def _parse_messages(trace: object) -> list[dict[str, Any]]:
    if not isinstance(trace, list):
        return []
    return [_parse_message(raw) for raw in trace]


def _parse_message(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("parts"), list):
        return {"kind": "unknown", "raw": raw}
    kind = raw.get("kind")
    if kind not in {"request", "response"}:
        return {"kind": "unknown", "raw": raw}
    message = dict(raw)
    message["kind"] = kind
    message["parts"] = [_parse_part(part) for part in raw["parts"]]
    if kind == "response" and "usage" in raw:
        message["usage"] = _normalize_usage(raw["usage"])
    return message


def _parse_part(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("part_kind"), str):
        return {"part_kind": "unknown", "raw": raw}
    part = dict(raw)
    if part["part_kind"] in {"tool-call", "builtin-tool-call"}:
        part["parsed_args"] = _parse_args(part.get("args"))
    return part


def _parse_args(args: object) -> object:
    if args is None:
        return None
    if not isinstance(args, str):
        return args
    try:
        return json.loads(args)
    except json.JSONDecodeError:
        return args


def _normalize_usage(raw: object) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    return {
        "input_tokens": _first_number(raw.get("input_tokens"), raw.get("request_tokens")),
        "output_tokens": _first_number(raw.get("output_tokens"), raw.get("response_tokens")),
        "cache_read_tokens": _first_number(raw.get("cache_read_tokens")),
    }


def _first_number(*values: object) -> int:
    for value in values:
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if isinstance(value, float) and math.isfinite(value):
            return int(value)
    return 0


def _trace_details(messages: list[dict[str, Any]], name: str) -> str:
    responses = [message for message in messages if message["kind"] == "response"]
    input_tokens = sum(_usage_value(message, "input_tokens") for message in responses)
    output_tokens = sum(_usage_value(message, "output_tokens") for message in responses)
    cached_tokens = sum(_usage_value(message, "cache_read_tokens") for message in responses)
    summary = [
        f"LLM CALLS: {len(responses)}",
        f"TOKENS: {_token_usage(input_tokens, output_tokens, cached_tokens)}",
    ]
    timestamps = [timestamp for message in messages for timestamp in _timestamps(message)]
    if len(timestamps) >= 2:
        summary.append(f"WALL TIME: {(max(timestamps) - min(timestamps)):.1f}s")
    return f"NAME: {_inline(name)}\n{' | '.join(summary)}"


def _usage_value(message: dict[str, Any], field: str) -> int:
    usage = message.get("usage")
    return usage.get(field, 0) if isinstance(usage, dict) else 0


def _timestamps(message: dict[str, Any]) -> list[float]:
    if message["kind"] == "unknown":
        return []
    values = [message.get("timestamp")]
    values.extend(part.get("timestamp") for part in message["parts"])
    return [parsed for value in values if (parsed := _timestamp(value)) is not None]


def _timestamp(value: object) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError):
        return None


def _request_envelope(state: object, number: int) -> str:
    label = f"REQUEST {number} [INTERRUPTED]" if state == "interrupted" else f"REQUEST {number}"
    return _envelope(label)


def _response_envelope(response: dict[str, Any], number: int) -> str:
    details = [
        f"RESPONSE {number} [INTERRUPTED]"
        if response.get("state") == "interrupted"
        else f"RESPONSE {number}"
    ]
    if response.get("model_name"):
        details.append(_inline(response["model_name"]))
    usage = response.get("usage")
    if isinstance(usage, dict):
        details.append(
            _token_usage(usage["input_tokens"], usage["output_tokens"], usage["cache_read_tokens"])
        )
    return _envelope(" · ".join(details))


def _token_usage(input_tokens: int, output_tokens: int, cached_tokens: int) -> str:
    cached = f" ({cached_tokens} cached)" if cached_tokens > 0 else ""
    return f"{input_tokens} in{cached} → {output_tokens} out"


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
            "COMPACTION",
            _js_string(content)
            if content
            else "[History compacted by the provider; no readable summary.]",
        )
    if kind == "file":
        return _part_section("FILE", _format_file(part.get("content")))
    return _part_section(f"UNKNOWN PART: {_inline(kind)}", _json(part))


def _format_tool_call(part: dict[str, Any]) -> str:
    kind = "BUILTIN TOOL CALL" if part["part_kind"] == "builtin-tool-call" else "TOOL CALL"
    tool_kind = f" [{_inline(part['tool_kind']).upper()}]" if part.get("tool_kind") else ""
    return _part_section(
        f"{kind}: {_inline(part.get('tool_name'))}{tool_kind}",
        f"ARGUMENTS:\n{_format_value(part.get('parsed_args'))}",
    )


def _format_tool_return(part: dict[str, Any]) -> str:
    kind = "BUILTIN TOOL RETURN" if part["part_kind"] == "builtin-tool-return" else "TOOL RETURN"
    outcome = part.get("outcome")
    outcome_label = f" [{outcome.upper()}]" if outcome in {"failed", "denied"} else ""
    return _part_section(
        f"{kind}: {_inline(part.get('tool_name'))}{outcome_label}",
        _format_value(part.get("content")),
    )


def _format_retry_prompt(part: dict[str, Any]) -> str:
    tool = f": {_inline(part['tool_name'])}" if part.get("tool_name") else ""
    return _part_section(f"RETRY PROMPT{tool}", _format_value(part.get("content")))


def _format_user_content(content: object) -> str:
    items = content if isinstance(content, list) else [content]
    return "\n\n".join(_format_user_item(item) for item in items)


def _format_user_item(item: object) -> str:
    if isinstance(item, str):
        return item
    if not isinstance(item, dict):
        return _json(item)
    if item.get("kind") == "text":
        return item["text"] if isinstance(item.get("text"), str) else _json(item)
    if item.get("kind") == "text-content":
        if isinstance(item.get("text"), str):
            return item["text"]
        if isinstance(item.get("content"), str):
            return item["content"]
        return _json(item)
    if item.get("kind") == "uploaded-file":
        return "[uploaded file]"
    if item.get("kind") == "cache-point":
        return "[cache point]"
    if _is_media(item):
        return _format_media(item)
    return _json(item)


def _format_file(content: object) -> str:
    return _format_media(content) if _is_media(content) else _json(content)


def _format_value(value: object) -> str:
    if isinstance(value, str):
        return value
    if _is_media(value):
        return _format_media(value)
    if isinstance(value, list) and any(_is_media(item) for item in value):
        return "\n\n".join(
            _format_media(item) if _is_media(item) else _format_value(item) for item in value
        )
    return _json(value)


def _is_media(value: object) -> bool:
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
        size = _base64_byte_length(_js_string(item.get("data")))
        return f"[binary: {media_type}, {_format_bytes(size)}, payload omitted]"
    return f"[{kind.removesuffix('-url')}] {_js_string(item.get('url'))}"


def _base64_byte_length(data: str) -> int:
    normalized = re.sub(r"\s", "", data)
    padding = 2 if normalized.endswith("==") else 1 if normalized.endswith("=") else 0
    return max(0, math.floor(len(normalized) * 3 / 4) - padding)


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


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
