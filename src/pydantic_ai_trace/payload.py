"""`TracePayload`: everything the viewer receives for one run tree.

This is the only contract between Python and the frontend. The frontend's types in
`frontend/src/generated/payload.ts` are generated from `payload_json_schema()`.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, JsonValue

from ._json import dumps_compact
from .analysis import Analysis, analyze
from .run_tree import MESSAGE_BYTES_CONFIG, RunTree
from .text import format_transcript


class TracePayload(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid") | MESSAGE_BYTES_CONFIG

    name: str
    run_tree: RunTree
    analysis: Analysis
    transcript: str

    def to_json(self) -> str:
        """JSON that stays valid UTF-8 even when untrusted text holds lone surrogates."""
        return dumps_compact(self.model_dump(mode="json"))


def build_payload(run_tree: RunTree, *, name: str) -> TracePayload:
    analysis = analyze(run_tree)
    return TracePayload(
        name=name,
        run_tree=run_tree,
        analysis=analysis,
        transcript=format_transcript(run_tree, analysis, name),
    )


def payload_json_schema() -> dict[str, JsonValue]:
    return TracePayload.model_json_schema(mode="serialization")
