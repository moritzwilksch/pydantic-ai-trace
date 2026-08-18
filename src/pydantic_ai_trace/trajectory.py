"""Tolerant normalization and compact JSON projection for trace dumps."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class TraceStats:
    llm_calls: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    wall_time_seconds: float | None


@dataclass(frozen=True)
class ParsedTrace:
    messages: tuple[dict[str, Any], ...]
    stats: TraceStats


def parse_trace(trace: object) -> ParsedTrace:
    """Normalize known wire fields while retaining unknown variants."""
    messages = tuple(_parse_message(raw) for raw in trace) if isinstance(trace, list) else ()
    responses = [message for message in messages if message["kind"] == "response"]
    timestamps = [timestamp for message in messages for timestamp in _timestamps(message)]
    wall_time = max(timestamps) - min(timestamps) if len(timestamps) >= 2 else None
    return ParsedTrace(
        messages=messages,
        stats=TraceStats(
            llm_calls=len(responses),
            input_tokens=sum(_usage_value(message, "input_tokens") for message in responses),
            output_tokens=sum(_usage_value(message, "output_tokens") for message in responses),
            cache_read_tokens=sum(
                _usage_value(message, "cache_read_tokens") for message in responses
            ),
            cache_write_tokens=sum(
                _usage_value(message, "cache_write_tokens") for message in responses
            ),
            wall_time_seconds=wall_time,
        ),
    )


def compact_trajectory(trace: ParsedTrace, *, name: str) -> dict[str, object]:
    """Build the compact, analysis-oriented trajectory representation."""
    stats: dict[str, object] = {
        "llm_calls": trace.stats.llm_calls,
        "tokens": _compact_tokens(
            trace.stats.input_tokens,
            trace.stats.output_tokens,
            trace.stats.cache_read_tokens,
            trace.stats.cache_write_tokens,
        ),
    }
    if trace.stats.wall_time_seconds is not None:
        stats["wall_time_seconds"] = round(trace.stats.wall_time_seconds, 3)

    messages: list[dict[str, object]] = []
    last_instructions: object = None
    for message in trace.messages:
        instructions = message.get("instructions")
        changed_instructions = (
            instructions
            if message["kind"] == "request" and instructions and instructions != last_instructions
            else None
        )
        if changed_instructions is not None:
            last_instructions = instructions
        messages.append(_compact_message(message, instructions=changed_instructions))

    return {"name": name, "stats": stats, "messages": messages}


def format_trace_json_as_compact_json(
    trace_json: str,
    *,
    name: str,
    indent: int | None = None,
) -> str:
    """Parse raw trace JSON and emit one compact JSON document."""
    document = compact_trajectory(parse_trace(json.loads(trace_json)), name=name)
    separators = (",", ":") if indent is None else None
    rendered = json.dumps(document, ensure_ascii=False, indent=indent, separators=separators)
    # Keep Unicode readable while escaping lone surrogates as valid JSON escapes.
    return rendered.encode("utf-8", errors="backslashreplace").decode("utf-8") + "\n"


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
    if args is None or not isinstance(args, str):
        return args
    try:
        return json.loads(args)
    except json.JSONDecodeError:
        return args


def _normalize_usage(raw: object) -> dict[str, object] | None:
    if not isinstance(raw, dict):
        return None
    details = raw.get("details")
    return {
        "input_tokens": _first_number(raw.get("input_tokens"), raw.get("request_tokens")),
        "output_tokens": _first_number(raw.get("output_tokens"), raw.get("response_tokens")),
        "cache_read_tokens": _first_number(raw.get("cache_read_tokens")),
        "cache_write_tokens": _first_number(raw.get("cache_write_tokens")),
        "details": details if isinstance(details, dict) else {},
    }


def _first_number(*values: object) -> int:
    for value in values:
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        if isinstance(value, float) and math.isfinite(value):
            return int(value)
    return 0


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


def _usage_value(message: dict[str, Any], field: str) -> int:
    usage = message.get("usage")
    value = usage.get(field, 0) if isinstance(usage, dict) else 0
    return value if isinstance(value, int) else 0


def _compact_message(message: dict[str, Any], *, instructions: object | None) -> dict[str, object]:
    if message["kind"] == "unknown":
        return {"type": "unknown", "data": _compact_value(message["raw"])}

    compact: dict[str, object] = {"type": message["kind"]}
    if message.get("state") == "interrupted":
        compact["state"] = "interrupted"
    if instructions is not None:
        compact["instructions"] = instructions
    if message["kind"] == "response":
        _copy_nonempty(message, compact, "model_name", "model")
        _copy_nonempty(message, compact, "provider_name", "provider")
        _copy_nonempty(message, compact, "finish_reason", "finish_reason")
        usage = message.get("usage")
        if isinstance(usage, dict):
            compact["usage"] = _compact_usage(usage)
    compact["parts"] = [
        rendered for part in message["parts"] if (rendered := _compact_part(part)) is not None
    ]
    return compact


def _compact_part(part: dict[str, Any]) -> dict[str, object] | None:
    kind = part["part_kind"]
    simple_types = {
        "system-prompt": "system",
        "user-prompt": "user",
        "text": "text",
        "thinking": "thinking",
    }
    if kind in simple_types:
        content = part.get("content")
        if kind == "thinking" and not content:
            return None
        if kind == "user-prompt":
            content = _compact_user_content(content)
        return {"type": simple_types[kind], "content": content}

    if kind in {"tool-call", "builtin-tool-call"}:
        compact = {
            "type": "tool_call",
            "name": part.get("tool_name"),
            "args": _compact_value(part.get("parsed_args")),
        }
        _copy_nonempty(part, compact, "tool_call_id", "id")
        _copy_nonempty(part, compact, "tool_kind", "tool_kind")
        if kind == "builtin-tool-call":
            compact["builtin"] = True
        return compact

    if kind in {"tool-return", "builtin-tool-return"}:
        compact = {
            "type": "tool_result",
            "name": part.get("tool_name"),
            "result": _compact_value(part.get("content")),
        }
        _copy_nonempty(part, compact, "tool_call_id", "id")
        _copy_nonempty(part, compact, "outcome", "outcome")
        _copy_nonempty(part, compact, "tool_kind", "tool_kind")
        if kind == "builtin-tool-return":
            compact["builtin"] = True
        return compact

    if kind == "retry-prompt":
        compact = {"type": "retry", "content": _compact_value(part.get("content"))}
        _copy_nonempty(part, compact, "tool_name", "name")
        _copy_nonempty(part, compact, "tool_call_id", "id")
        return compact

    if kind == "compaction":
        return {
            "type": "compaction",
            "content": part.get("content")
            or "[History compacted by the provider; no readable summary.]",
        }

    if kind == "file":
        content = part.get("content")
        if _is_media(content):
            return _compact_media(content)
        return {"type": "file", "content": content}

    raw = part.get("raw", part)
    original_type = kind
    if isinstance(raw, dict):
        original_type = raw.get("part_kind", kind)
        data = {key: value for key, value in raw.items() if key != "part_kind"}
    else:
        data = raw
    return {"type": "unknown", "original_type": original_type, "data": _compact_value(data)}


def _compact_usage(usage: dict[str, object]) -> dict[str, object]:
    compact = _compact_tokens(
        _integer(usage.get("input_tokens")),
        _integer(usage.get("output_tokens")),
        _integer(usage.get("cache_read_tokens")),
        _integer(usage.get("cache_write_tokens")),
    )
    details = usage.get("details")
    if isinstance(details, dict) and details:
        compact["details"] = details
    return compact


def _compact_tokens(input_tokens: int, output_tokens: int, cache_read: int, cache_write: int):
    compact: dict[str, object] = {"input": input_tokens}
    if cache_read:
        compact["cache_read"] = cache_read
    if cache_write:
        compact["cache_write"] = cache_write
    compact["output"] = output_tokens
    return compact


def _integer(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _copy_nonempty(
    source: dict[str, Any], target: dict[str, object], source_key: str, target_key: str
) -> None:
    value = source.get(source_key)
    if value is not None and value != "":
        target[target_key] = value


def _compact_user_content(content: object) -> object:
    if not isinstance(content, list):
        return content
    return [_compact_user_item(item) for item in content]


def _compact_user_item(item: object) -> object:
    if not isinstance(item, dict):
        return item
    kind = item.get("kind")
    if kind == "text" and isinstance(item.get("text"), str):
        return item["text"]
    if kind == "text-content":
        if isinstance(item.get("text"), str):
            return item["text"]
        if isinstance(item.get("content"), str):
            return item["content"]
    if kind == "uploaded-file":
        return {"type": "uploaded_file"}
    if kind == "cache-point":
        return {"type": "cache_point"}
    if _is_media(item):
        return _compact_media(item)
    return item


def _compact_value(value: object) -> object:
    if _is_media(value):
        return _compact_media(value)
    if isinstance(value, list):
        return [_compact_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _compact_value(child) for key, child in value.items()}
    return value


def _is_media(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    kind = value.get("kind")
    if kind == "binary":
        return isinstance(value.get("data"), str)
    return isinstance(kind, str) and kind.endswith("-url") and isinstance(value.get("url"), str)


def _compact_media(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    kind = value.get("kind")
    if kind == "binary":
        return {
            "type": "file",
            "media_type": value.get("media_type") or "application/octet-stream",
            "bytes": _base64_byte_length(str(value.get("data", ""))),
            "payload_omitted": True,
        }
    assert isinstance(kind, str)
    return {"type": kind.removesuffix("-url"), "url": value["url"]}


def _base64_byte_length(data: str) -> int:
    normalized = re.sub(r"\s", "", data)
    padding = 2 if normalized.endswith("==") else 1 if normalized.endswith("=") else 0
    return max(0, math.floor(len(normalized) * 3 / 4) - padding)
