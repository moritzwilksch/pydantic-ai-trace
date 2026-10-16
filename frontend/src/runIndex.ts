// Lookups that join a run's analysis (computed in Python) to its message and part
// positions, plus the run tree in display order.

import type { Part, PartRef, Run, RunAnalysis, ToolCallInfo, TracePayload } from "./types";

export interface RunEntry {
  run: Run;
  analysis: RunAnalysis;
}

export interface RunIndex {
  entry: RunEntry;
  toolCall(message: number, part: number): ToolCallInfo | undefined;
  isMatchedResult(message: number, part: number): boolean;
  responseCost(message: number): string | null;
  part(ref: PartRef): Part | undefined;
}

export interface TrajectoryIndex {
  entries: Map<string, RunEntry>;
  /** Top-level runs, including runs whose parent is not recorded, by start time. */
  roots: RunEntry[];
  children(runId: string): RunEntry[];
}

export function indexTrajectory(payload: TracePayload): TrajectoryIndex {
  const entries = new Map<string, RunEntry>();
  payload.trajectory.runs.forEach((run, i) => {
    entries.set(run.id, { run, analysis: payload.analysis.runs[i] });
  });
  const byStart = (a: RunEntry, b: RunEntry) =>
    Date.parse(a.run.started_at) - Date.parse(b.run.started_at);
  const all = [...entries.values()];
  const childrenOf = new Map<string, RunEntry[]>();
  for (const entry of all) {
    const parentId = entry.run.parent?.run_id;
    if (parentId === undefined || !entries.has(parentId)) continue;
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), entry]);
  }
  for (const children of childrenOf.values()) children.sort(byStart);
  return {
    entries,
    roots: all.filter((entry) => !entries.has(entry.run.parent?.run_id ?? "")).sort(byStart),
    children: (runId) => childrenOf.get(runId) ?? [],
  };
}

export function indexRun(entry: RunEntry): RunIndex {
  const key = (message: number, part: number) => `${message}:${part}`;
  const toolCalls = new Map(
    entry.analysis.tool_calls.map((info) => [key(info.call.message, info.call.part), info]),
  );
  const matched = new Set(entry.analysis.matched_results.map((ref) => key(ref.message, ref.part)));
  const costs = new Map(entry.analysis.responses.map((info) => [info.message, info.cost_usd]));
  return {
    entry,
    toolCall: (message, part) => toolCalls.get(key(message, part)),
    isMatchedResult: (message, part) => matched.has(key(message, part)),
    responseCost: (message) => costs.get(message) ?? null,
    part: (ref) => entry.run.messages[ref.message]?.parts[ref.part],
  };
}
