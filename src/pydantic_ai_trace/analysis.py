"""Facts the viewer derives from a run tree: tool pairing, output calls, cost, and totals.

Everything is keyed by position (`PartRef`) into the run tree's own messages, so
renderers read the canonical messages and join these facts by index.
"""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Iterable
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, JsonValue
from pydantic_ai.messages import (
    BaseToolCallPart,
    BaseToolReturnPart,
    ModelResponse,
    RetryPromptPart,
    ToolReturnPart,
)

from ._json import loads_finite
from .run_tree import Run, RunId, RunTree

# Message history does not mark output tools: their name is configurable
# (`ToolOutput(name=...)`, default `final_result`) and `tool_kind` stays unset. Pydantic AI
# answers the call whose arguments became the run's output with this fixed status return
# (`_FINAL_RESULT_PROCESSED` in `pydantic_ai._tool_execution`), so it identifies the output call.
FINAL_RESULT_STATUS = "Final result processed."


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class PartRef(_Frozen):
    message: int
    part: int


class ToolCallInfo(_Frozen):
    call: PartRef
    args: JsonValue  # Parsed from a JSON string when possible.
    result: PartRef | None  # The next chronological return or retry with the same id.
    child_run_ids: tuple[RunId, ...]
    is_output: bool  # Its args are the run's output; see `FINAL_RESULT_STATUS`.


class Tokens(_Frozen):
    input: int = 0
    output: int = 0
    cache_read: int = 0
    cache_write: int = 0


class Totals(_Frozen):
    llm_calls: int
    tokens: Tokens
    cost_usd: Decimal | None  # Exact; None when no response could be priced.
    unpriced_calls: int
    duration_seconds: float


class ResponseInfo(_Frozen):
    message: int
    cost_usd: Decimal | None


class RunAnalysis(_Frozen):
    run_id: RunId
    parent_missing: bool  # The parent is named but not recorded (yet).
    totals: Totals
    subtree_totals: Totals
    responses: tuple[ResponseInfo, ...]
    tool_calls: tuple[ToolCallInfo, ...]
    matched_results: tuple[PartRef, ...]
    child_run_ids: tuple[RunId, ...]  # Recorded children, in tree order.
    nested_run_ids: tuple[RunId, ...]  # Children not started by a tool call.


class Analysis(_Frozen):
    totals: Totals
    runs: tuple[RunAnalysis, ...]  # Same order as `RunTree.runs`.
    root_run_ids: tuple[RunId, ...]  # Top-level runs, in tree order.


def analyze(run_tree: RunTree) -> Analysis:
    ids = {run.id for run in run_tree.runs}
    own = {run.id: _run_totals(run) for run in run_tree.runs}
    # Children before parents (reversed tree order), without recursion: a run tree can be
    # deeper than Python's recursion limit.
    subtree: dict[RunId, Totals] = {}
    bounds: dict[RunId, tuple[datetime, datetime]] = {}
    for run, _ in reversed(run_tree.walk()):
        children = run_tree.children(run.id)
        start = min([run.started_at, *(bounds[child.id][0] for child in children)])
        end = max([run.ended_at, *(bounds[child.id][1] for child in children)])
        bounds[run.id] = (start, end)
        subtree[run.id] = combine_totals(
            [own[run.id], *(subtree[child.id] for child in children)], _seconds(start, end)
        )

    runs = tuple(
        _analyze_run(
            run,
            children=run_tree.children(run.id),
            parent_missing=run.parent is not None and run.parent.run_id not in ids,
            totals=own[run.id],
            subtree_totals=subtree[run.id],
        )
        for run in run_tree.runs
    )
    return Analysis(
        totals=combine_totals(own.values(), _span(run_tree.runs)),
        runs=runs,
        root_run_ids=tuple(run.id for run in run_tree.roots()),
    )


def _analyze_run(
    run: Run,
    *,
    children: list[Run],
    parent_missing: bool,
    totals: Totals,
    subtree_totals: Totals,
) -> RunAnalysis:
    tool_calls, matched = _pair_tool_calls(run, children)
    return RunAnalysis(
        run_id=run.id,
        parent_missing=parent_missing,
        totals=totals,
        subtree_totals=subtree_totals,
        responses=tuple(
            ResponseInfo(message=index, cost_usd=_cost(message))
            for index, message in enumerate(run.messages)
            if isinstance(message, ModelResponse)
        ),
        tool_calls=tool_calls,
        matched_results=matched,
        child_run_ids=tuple(child.id for child in children),
        nested_run_ids=tuple(
            child.id for child in children if child.parent and child.parent.tool_call_id is None
        ),
    )


def _pair_tool_calls(
    run: Run, children: list[Run]
) -> tuple[tuple[ToolCallInfo, ...], tuple[PartRef, ...]]:
    """Pair each call with the next result carrying its id, in message order."""
    children_by_call: dict[str, list[RunId]] = defaultdict(list)
    for child in children:
        if child.parent is not None and child.parent.tool_call_id is not None:
            children_by_call[child.parent.tool_call_id].append(child.id)

    calls: list[tuple[PartRef, BaseToolCallPart]] = []
    pending: dict[str, deque[int]] = defaultdict(deque)
    results: dict[int, PartRef] = {}
    outputs: set[int] = set()
    for message_index, message in enumerate(run.messages):
        for part_index, part in enumerate(message.parts):
            ref = PartRef(message=message_index, part=part_index)
            if isinstance(part, BaseToolCallPart):
                pending[part.tool_call_id].append(len(calls))
                calls.append((ref, part))
            elif isinstance(part, BaseToolReturnPart | RetryPromptPart):
                waiting = pending.get(part.tool_call_id)
                if waiting:
                    index = waiting.popleft()
                    results[index] = ref
                    if _is_final_result_status(part):
                        outputs.add(index)

    infos = tuple(
        ToolCallInfo(
            call=ref,
            args=parse_tool_args(part.args),
            result=results.get(index),
            child_run_ids=tuple(children_by_call.get(part.tool_call_id, ())),
            is_output=index in outputs,
        )
        for index, (ref, part) in enumerate(calls)
    )
    return infos, tuple(sorted(results.values(), key=lambda ref: (ref.message, ref.part)))


def _is_final_result_status(part: BaseToolReturnPart | RetryPromptPart) -> bool:
    return isinstance(part, ToolReturnPart) and part.content == FINAL_RESULT_STATUS


def parse_tool_args(args: str | dict[str, object] | None) -> JsonValue:
    """Parse a JSON string; keep the string when it is not standard JSON (e.g. `1e400`)."""
    if not isinstance(args, str):
        return args  # type: ignore[return-value]  # validated JSON-compatible dict or None
    try:
        return loads_finite(args)  # type: ignore[return-value]  # parsed JSON
    except ValueError:  # includes json.JSONDecodeError
        return args


def _cost(response: ModelResponse) -> Decimal | None:
    if not response.model_name:
        return None
    try:
        return response.cost().total_price
    # LookupError: genai-prices does not know the model or provider.
    # ValueError: it rejects the usage, e.g. more cached than input tokens.
    except (LookupError, ValueError):
        return None


def _run_totals(run: Run) -> Totals:
    responses = [message for message in run.messages if isinstance(message, ModelResponse)]
    costs = [_cost(response) for response in responses]
    priced = [cost for cost in costs if cost is not None]
    return Totals(
        llm_calls=len(responses),
        tokens=Tokens(
            input=sum(response.usage.input_tokens for response in responses),
            output=sum(response.usage.output_tokens for response in responses),
            cache_read=sum(response.usage.cache_read_tokens for response in responses),
            cache_write=sum(response.usage.cache_write_tokens for response in responses),
        ),
        cost_usd=sum(priced, Decimal(0)) if priced else None,
        unpriced_calls=len(costs) - len(priced),
        duration_seconds=_seconds(run.started_at, run.ended_at),
    )


def combine_totals(totals: Iterable[Totals], duration_seconds: float) -> Totals:
    """Sum calls, tokens, and cost; the caller decides what the combined duration is."""
    items = list(totals)
    costs = [item.cost_usd for item in items if item.cost_usd is not None]
    return Totals(
        llm_calls=sum(item.llm_calls for item in items),
        tokens=Tokens(
            input=sum(item.tokens.input for item in items),
            output=sum(item.tokens.output for item in items),
            cache_read=sum(item.tokens.cache_read for item in items),
            cache_write=sum(item.tokens.cache_write for item in items),
        ),
        cost_usd=sum(costs, Decimal(0)) if costs else None,
        unpriced_calls=sum(item.unpriced_calls for item in items),
        duration_seconds=duration_seconds,
    )


def _span(runs: Iterable[Run]) -> float:
    items = list(runs)
    return _seconds(min(run.started_at for run in items), max(run.ended_at for run in items))


def _seconds(start: datetime, end: datetime) -> float:
    return max(0.0, (end - start).total_seconds())
