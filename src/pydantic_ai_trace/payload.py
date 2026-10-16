"""`TracePayload`: everything the viewer receives for one trajectory.

This is the only contract between Python and the frontend. The frontend's types in
`frontend/src/generated/payload.ts` are generated from `payload_json_schema()`.
"""

from __future__ import annotations

import json

from pydantic import BaseModel, ConfigDict, JsonValue

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
        """ASCII JSON, so untrusted text such as lone surrogates stays valid JSON."""
        return json.dumps(
            self.model_dump(mode="json"), ensure_ascii=True, allow_nan=False, separators=(",", ":")
        )


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
