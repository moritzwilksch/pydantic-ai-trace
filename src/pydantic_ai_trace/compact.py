"""Compact, analysis-oriented JSON projection of a trace payload (`paitrace json`)."""

from __future__ import annotations

from typing import Any

from pydantic_ai.messages import ModelMessagesTypeAdapter

from ._json import dumps_readable
from .analysis import Totals, parse_tool_args
from .payload import TracePayload
from .text import (
    COMPACTION_PLACEHOLDER,
    base64_byte_length,
    changed_instructions,
    discovered_tools,
    is_media,
)
from .trajectory import Run


def compact_payload(payload: TracePayload) -> dict[str, object]:
    """Runs in recorded order, each with its messages in order and its own stats."""
    analyses = {run.run_id: run for run in payload.analysis.runs}
    return {
        "name": payload.name,
        "stats": compact_totals(payload.analysis.totals),
        "runs": [_compact_run(run, analyses[run.id].totals) for run in payload.trajectory.runs],
    }


def format_compact_json(payload: TracePayload, *, indent: int | None = None) -> str:
    """One compact JSON document, newline-terminated."""
    separators = (",", ":") if indent is None else None
    return dumps_readable(compact_payload(payload), indent=indent, separators=separators) + "\n"


def _compact_run(run: Run, totals: Totals) -> dict[str, object]:
    compact: dict[str, object] = {"id": run.id, "name": run.name}
    if run.parent is not None:
        compact["parent"] = run.parent.model_dump(mode="json", exclude_none=True)
    compact["outcome"] = run.outcome.model_dump(mode="json")
    compact["started_at"] = run.started_at.isoformat()
    compact["ended_at"] = run.ended_at.isoformat()
    compact["stats"] = compact_totals(totals)

    messages: list[dict[str, Any]] = ModelMessagesTypeAdapter.dump_python(
        list(run.messages), mode="json"
    )
    compact["messages"] = [
        _compact_message(message, instructions=instructions)
        for message, instructions in zip(messages, changed_instructions(messages), strict=True)
    ]
    return compact


def compact_totals(totals: Totals) -> dict[str, object]:
    """The `stats` object of `paitrace json` and `paitrace stats --json`."""
    stats: dict[str, object] = {
        "llm_calls": totals.llm_calls,
        "tokens": _compact_tokens(
            totals.tokens.input,
            totals.tokens.output,
            totals.tokens.cache_read,
            totals.tokens.cache_write,
        ),
    }
    if totals.cost_usd is not None:
        stats["cost_usd"] = float(totals.cost_usd)  # a JSON number, for jq
    if totals.unpriced_calls:
        stats["unpriced_calls"] = totals.unpriced_calls
    stats["wall_time_seconds"] = round(totals.duration_seconds, 3)
    return stats


def _compact_message(message: dict[str, Any], *, instructions: object | None) -> dict[str, object]:
    compact: dict[str, object] = {"type": message["kind"]}
    if message.get("state") not in {None, "complete"}:
        compact["state"] = message["state"]
    if instructions is not None:
        compact["instructions"] = instructions
    if message["kind"] == "response":
        _copy_nonempty(message, compact, "model_name", "model")
        _copy_nonempty(message, compact, "provider_name", "provider")
        _copy_nonempty(message, compact, "finish_reason", "finish_reason")
        compact["usage"] = _compact_usage(message["usage"])
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
            "args": _compact_value(parse_tool_args(part.get("args"))),
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
            "result": _compact_tool_return_content(part),
        }
        _copy_nonempty(part, compact, "tool_call_id", "id")
        if part.get("outcome") not in {None, "success"}:
            compact["outcome"] = part["outcome"]
        _copy_nonempty(part, compact, "tool_kind", "tool_kind")
        if kind == "builtin-tool-return":
            compact["builtin"] = True
        return compact

    if kind == "retry-prompt":
        compact = {"type": "retry", "content": _compact_value(part.get("content"))}
        _copy_nonempty(part, compact, "tool_name", "name")
        _copy_nonempty(part, compact, "tool_call_id", "id")
        return compact

    if kind == "tool-availability-delta":
        compact = {"type": "tools_available", "tools_added": part["tools_added"]}
        _copy_nonempty(part, compact, "tool_call_id", "id")
        return compact

    if kind == "compaction":
        return {"type": "compaction", "content": part.get("content") or COMPACTION_PLACEHOLDER}

    if kind == "file":
        content = part.get("content")
        if is_media(content):
            return _compact_media(content)
        return {"type": "file", "content": content}

    data = {key: value for key, value in part.items() if key != "part_kind"}
    return {"type": "other", "original_type": kind, "data": _compact_value(data)}


def _compact_tool_return_content(part: dict[str, Any]) -> object:
    """A tool-search return is a list of names wrapped in per-match objects; unwrap it."""
    discovered = discovered_tools(part)
    if discovered is None:
        return _compact_value(part.get("content"))
    compact: dict[str, object] = {"discovered_tools": discovered}
    _copy_nonempty(part["content"], compact, "message", "message")
    return compact


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
    if kind == "text-content":
        return item.get("content")
    if kind == "uploaded-file":
        return {"type": "uploaded_file"}
    if kind == "cache-point":
        return {"type": "cache_point"}
    if is_media(item):
        return _compact_media(item)
    return item


def _compact_value(value: object) -> object:
    if is_media(value):
        return _compact_media(value)
    if isinstance(value, list):
        return [_compact_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _compact_value(child) for key, child in value.items()}
    return value


def _compact_media(value: object) -> dict[str, object]:
    assert isinstance(value, dict)
    kind = value.get("kind")
    if kind == "binary":
        return {
            "type": "file",
            "media_type": value.get("media_type") or "application/octet-stream",
            "bytes": base64_byte_length(str(value.get("data", ""))),
            "payload_omitted": True,
        }
    assert isinstance(kind, str)
    return {"type": kind.removesuffix("-url"), "url": value["url"]}
