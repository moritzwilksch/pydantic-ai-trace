// Lookups that join a run's analysis (computed in Python) to its message and part
// positions, plus the run tree in display order.

import type { Part, Run, RunAnalysis, ToolCallInfo, TracePayload } from "./types";

export interface RunEntry {
  run: Run;
  analysis: RunAnalysis;
}

export interface RunIndex {
  entry: RunEntry;
  toolCall(message: number, part: number): ToolCallInfo | undefined;
  toolResult(info: ToolCallInfo): Part | null;
  /** The recorded runs a tool call started. */
  childRuns(info: ToolCallInfo): RunEntry[];
  /** The recorded runs this run started outside a tool call. */
  nestedRuns: RunEntry[];
  isMatchedResult(message: number, part: number): boolean;
  /** The return that accepted the run's output call; see `ToolCallInfo.is_output`. */
  isOutputResult(message: number, part: number): boolean;
  responseCost(message: number): string | null;
}

export interface TrajectoryIndex {
  entries: Map<string, RunEntry>;
  /** Top-level runs, including runs whose parent is not recorded, by start time. */
  roots: RunEntry[];
  children(runId: string): RunEntry[];
  /** The recorded ancestors of a run, outermost first. */
  ancestors(runId: string): RunEntry[];
}

export function indexTrajectory(payload: TracePayload): TrajectoryIndex {
  const entries = new Map<string, RunEntry>();
  payload.trajectory.runs.forEach((run, i) => {
    entries.set(run.id, { run, analysis: payload.analysis.runs[i] });
  });
  const byStart = (a: RunEntry, b: RunEntry) =>
    Date.parse(a.run.started_at) - Date.parse(b.run.started_at);
  // A run ID may be any string, including "", so an absent parent is `undefined`.
  const parentOf = (entry: RunEntry): RunEntry | undefined =>
    entry.run.parent === null ? undefined : entries.get(entry.run.parent.run_id);
  const all = [...entries.values()];
  const childrenOf = new Map<string, RunEntry[]>();
  for (const entry of all) {
    const parent = parentOf(entry);
    if (parent === undefined) continue;
    childrenOf.set(parent.run.id, [...(childrenOf.get(parent.run.id) ?? []), entry]);
  }
  for (const children of childrenOf.values()) children.sort(byStart);
  return {
    entries,
    roots: all.filter((entry) => parentOf(entry) === undefined).sort(byStart),
    children: (runId) => childrenOf.get(runId) ?? [],
    ancestors: (runId) => {
      const chain: RunEntry[] = [];
      const start = entries.get(runId);
      let parent = start === undefined ? undefined : parentOf(start);
      while (parent !== undefined) {
        chain.unshift(parent);
        parent = parentOf(parent);
      }
      return chain;
    },
  };
}

export function indexRun(entry: RunEntry, trajectory: TrajectoryIndex): RunIndex {
  const key = (message: number, part: number) => `${message}:${part}`;
  const toolCalls = new Map(
    entry.analysis.tool_calls.map((info) => [key(info.call.message, info.call.part), info]),
  );
  const matched = new Set(entry.analysis.matched_results.map((ref) => key(ref.message, ref.part)));
  const outputResults = new Set(
    entry.analysis.tool_calls.flatMap(({ is_output, result }) =>
      is_output && result !== null ? [key(result.message, result.part)] : [],
    ),
  );
  const costs = new Map(entry.analysis.responses.map((info) => [info.message, info.cost_usd]));
  const recorded = (ids: readonly string[]) =>
    ids.map((id) => trajectory.entries.get(id)).filter((run) => run !== undefined);
  return {
    entry,
    toolCall: (message, part) => toolCalls.get(key(message, part)),
    toolResult: ({ result }) =>
      result === null ? null : (entry.run.messages[result.message]?.parts[result.part] ?? null),
    childRuns: (info) => recorded(info.child_run_ids),
    nestedRuns: recorded(entry.analysis.nested_run_ids),
    isMatchedResult: (message, part) => matched.has(key(message, part)),
    isOutputResult: (message, part) => outputResults.has(key(message, part)),
    responseCost: (message) => costs.get(message) ?? null,
  };
}
