"""`TracePayload`: everything the viewer receives for one trajectory.

This is the only contract between Python and the frontend. The frontend's types in
`frontend/src/generated/payload.ts` are generated from `payload_json_schema()`.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, JsonValue

from ._json import dumps_compact
from .analysis import Analysis, analyze
from .text import format_transcript
from .trajectory import MESSAGE_BYTES_CONFIG, Trajectory


class TracePayload(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid") | MESSAGE_BYTES_CONFIG

    name: str
    trajectory: Trajectory
    analysis: Analysis
    transcript: str

    def to_json(self) -> str:
        """JSON that stays valid UTF-8 even when untrusted text holds lone surrogates."""
        return dumps_compact(self.model_dump(mode="json"))


def build_payload(trajectory: Trajectory, *, name: str) -> TracePayload:
    analysis = analyze(trajectory)
    return TracePayload(
        name=name,
        trajectory=trajectory,
        analysis=analysis,
        transcript=format_transcript(trajectory, analysis, name),
    )


def payload_json_schema() -> dict[str, JsonValue]:
    return TracePayload.model_json_schema(mode="serialization")
