import asyncio
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import BaseModel
from pydantic_ai import Agent, ToolOutput
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RequestUsage

from pydantic_ai_trace import Completed, Parent, Run, RunId, ToolCallId, Trajectory
from pydantic_ai_trace.analysis import PartRef, analyze
from pydantic_ai_trace.payload import build_payload

FIXTURES = Path(__file__).parent / "fixtures"
START = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)


def single_run(*messages: ModelRequest | ModelResponse, **fields: object) -> Run:
    values: dict[str, object] = {
        "id": RunId("run"),
        "name": "run",
        "parent": None,
        "started_at": START,
        "ended_at": START + timedelta(seconds=4),
        "outcome": Completed(),
        "messages": messages,
    }
    return Run.model_validate({**values, **fields})


def call(*ids: str) -> ModelResponse:
    return ModelResponse(
        parts=[ToolCallPart(tool_name="t", args='{"a": 1}', tool_call_id=i) for i in ids]
    )


def returns(*ids: str) -> ModelRequest:
    return ModelRequest(
        parts=[ToolReturnPart(tool_name="t", content="ok", tool_call_id=i) for i in ids]
    )


class TestToolPairing:
    def test_pairs_calls_with_results_in_later_messages(self):
        analysis = analyze(Trajectory(runs=(single_run(call("a", "b"), returns("b", "a")),)))

        [run] = analysis.runs
        assert [(info.call, info.result) for info in run.tool_calls] == [
            (PartRef(message=0, part=0), PartRef(message=1, part=1)),
            (PartRef(message=0, part=1), PartRef(message=1, part=0)),
        ]
        assert run.matched_results == (PartRef(message=1, part=0), PartRef(message=1, part=1))

    def test_a_retry_answers_a_call(self):
        retry = ModelRequest(
            parts=[RetryPromptPart(content="bad", tool_name="t", tool_call_id="a")]
        )

        [run] = analyze(Trajectory(runs=(single_run(call("a"), retry),))).runs

        assert run.tool_calls[0].result == PartRef(message=1, part=0)

    def test_reused_ids_pair_chronologically(self):
        [run] = analyze(
            Trajectory(runs=(single_run(call("a"), returns("a"), call("a"), returns("a")),))
        ).runs

        assert [info.result for info in run.tool_calls] == [
            PartRef(message=1, part=0),
            PartRef(message=3, part=0),
        ]

    def test_unanswered_calls_and_orphan_results_stay_unpaired(self):
        [run] = analyze(Trajectory(runs=(single_run(returns("x"), call("a")),))).runs

        assert run.tool_calls[0].result is None
        assert run.matched_results == ()

    @pytest.mark.parametrize("args", ['{"x": 1e400}', '{"x": [1, NaN]}', '{"x": -Infinity}'])
    def test_args_with_non_finite_numbers_stay_strings_and_serialize(self, args: str):
        response = ModelResponse(
            parts=[ToolCallPart(tool_name="t", args=args, tool_call_id="a")], timestamp=START
        )
        trajectory = Trajectory(runs=(single_run(response),))

        [run] = analyze(trajectory).runs

        assert run.tool_calls[0].args == args
        assert json.loads(build_payload(trajectory, name="t").to_json())["name"] == "t"

    def test_args_are_parsed_from_json_strings(self):
        [run] = analyze(Trajectory(runs=(single_run(call("a")),))).runs

        assert run.tool_calls[0].args == {"a": 1}


class Answer(BaseModel):
    city: str


class TestOutputCalls:
    def test_the_accepted_output_call_is_marked_whatever_its_name(self):
        """A real run: the model's first output fails validation, the second is accepted."""
        outputs = iter(['{"city": 1}', '{"city": "Berlin"}'])

        def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            return ModelResponse(
                parts=[
                    ToolCallPart(tool_name="search", args="{}", tool_call_id=f"s{len(messages)}"),
                    ToolCallPart(tool_name="answer", args=next(outputs)),
                ]
            )

        agent = Agent(FunctionModel(model), output_type=ToolOutput(Answer, name="answer"))

        @agent.tool_plain
        def search() -> str:
            return "Berlin"

        messages = asyncio.run(agent.run("Where?")).all_messages()

        [run] = analyze(Trajectory(runs=(single_run(*messages),))).runs
        accepted = PartRef(message=3, part=1)  # The second response's `answer` call.
        assert [info.call for info in run.tool_calls if info.is_output] == [accepted]


class TestTree:
    def test_children_attach_to_their_tool_call_or_as_nested_runs(self):
        trajectory = Trajectory.model_validate_json((FIXTURES / "trajectory.json").read_text())
        nested = single_run(
            ModelResponse(parts=[TextPart(content="checked")], timestamp=START),
            id=RunId("validator"),
            name="validator",
            parent=Parent(run_id=RunId("worker")),
        )

        analysis = analyze(Trajectory(runs=(*trajectory.runs, nested)))

        worker = next(run for run in analysis.runs if run.run_id == "worker")
        assert worker.tool_calls[0].child_run_ids == ("subagent",)
        assert worker.nested_run_ids == ("validator",)
        assert worker.child_run_ids == ("validator", "subagent")  # by start
        assert analysis.root_run_ids == ("planner", "worker", "summarizer")

    def test_a_missing_parent_is_flagged(self):
        child = single_run(
            ModelResponse(parts=[TextPart(content="x")]),
            parent=Parent(run_id=RunId("later"), tool_call_id=ToolCallId("c")),
        )

        [run] = analyze(Trajectory(runs=(child,))).runs

        assert run.parent_missing is True


class TestTotals:
    def test_subtree_totals_add_descendants_and_span_their_time(self):
        analysis = analyze(
            Trajectory.model_validate_json((FIXTURES / "trajectory.json").read_text())
        )
        by_id = {str(run.run_id): run for run in analysis.runs}

        assert by_id["worker"].totals.llm_calls == 2
        assert by_id["worker"].subtree_totals.llm_calls == 3
        assert by_id["worker"].subtree_totals.tokens.input == 300
        assert by_id["worker"].subtree_totals.duration_seconds == 3
        assert analysis.totals.llm_calls == 5
        assert analysis.totals.duration_seconds == 6

    def test_cost_comes_from_genai_prices(self):
        priced = ModelResponse(
            parts=[TextPart(content="x")],
            model_name="gpt-4o",
            provider_name="openai",
            usage=RequestUsage(input_tokens=1_000_000, output_tokens=0),
            timestamp=START,
        )

        [run] = analyze(Trajectory(runs=(single_run(priced),))).runs

        assert run.responses[0].cost_usd == pytest.approx(priced.cost().total_price)
        assert run.totals.cost_usd == run.responses[0].cost_usd
        assert run.totals.unpriced_calls == 0

    def test_usage_that_genai_prices_rejects_is_unpriced(self):
        inconsistent = ModelResponse(
            parts=[TextPart(content="x")],
            model_name="gpt-4o",
            usage=RequestUsage(input_tokens=1, cache_read_tokens=2),
            timestamp=START,
        )

        [run] = analyze(Trajectory(runs=(single_run(inconsistent),))).runs

        assert run.responses[0].cost_usd is None
        assert (run.totals.cost_usd, run.totals.unpriced_calls) == (None, 1)
        assert (run.totals.tokens.input, run.totals.tokens.cache_read) == (1, 2)

    def test_unknown_models_are_counted_as_unpriced_not_free(self):
        unknown = ModelResponse(parts=[TextPart(content="x")], model_name="in-house-model")

        [run] = analyze(Trajectory(runs=(single_run(unknown),))).runs

        assert run.responses[0].cost_usd is None
        assert run.totals.cost_usd is None
        assert run.totals.unpriced_calls == 1


def test_a_chain_deeper_than_the_recursion_limit_is_analyzed():
    depth = sys.getrecursionlimit() + 500
    chain = tuple(
        single_run(
            ModelResponse(
                parts=[TextPart(content="x")],
                usage=RequestUsage(input_tokens=1),
                timestamp=START + timedelta(seconds=i),
            ),
            id=RunId(f"r{i}"),
            name=f"r{i}",
            parent=Parent(run_id=RunId(f"r{i - 1}")) if i else None,
            started_at=START + timedelta(seconds=i),
            ended_at=START + timedelta(seconds=i + 1),
        )
        for i in range(depth)
    )
    trajectory = Trajectory(runs=tuple(reversed(chain)))  # recorded in end order

    analysis = analyze(trajectory)
    payload = build_payload(trajectory, name="deep")

    assert [run.id for run, _ in trajectory.walk()] == [f"r{i}" for i in range(depth)]
    root = next(run for run in analysis.runs if run.run_id == "r0")
    assert root.subtree_totals.llm_calls == depth
    assert root.subtree_totals.tokens.input == depth
    assert root.subtree_totals.duration_seconds == depth
    assert payload.transcript.count("========== RUN:") == depth
