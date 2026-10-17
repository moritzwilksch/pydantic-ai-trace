from pathlib import Path

import pytest
from _pytest.mark import ParameterSet

from pydantic_ai_trace.load import load_trajectory
from pydantic_ai_trace.payload import build_payload
from pydantic_ai_trace.scan import iter_trace_files, jsonl_lines

EXAMPLES = Path(__file__).parent.parent / "examples" / "traces"


def _traces() -> list[ParameterSet]:
    traces = []
    for path in iter_trace_files(EXAMPLES):
        name = path.relative_to(EXAMPLES).as_posix()
        with path.open(encoding="utf-8") as file:
            texts = list(jsonl_lines(file)) if path.suffix == ".jsonl" else [file.read()]
        traces += [pytest.param(text, id=f"{name}:{i}") for i, text in enumerate(texts, start=1)]
    return traces


@pytest.mark.parametrize("text", _traces())
def test_example_traces_load_and_render(text: str):
    build_payload(load_trajectory(text, name="example"), name="example")
