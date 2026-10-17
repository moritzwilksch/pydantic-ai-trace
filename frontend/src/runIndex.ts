// Lookups that join a run's analysis (computed in Python) to its message and part
// positions, plus the run tree in display order.

import type { Part, PartRef, Run, RunAnalysis, ToolCallInfo, TracePayload } from "./types";

export interface RunEntry {
  run: Run;
  analysis: RunAnalysis;
}

/** A tool call with its 1-based position among the run's calls, shown on both ends of the pair. */
export interface NumberedToolCall {
  number: number;
  info: ToolCallInfo;
}

export interface RunIndex {
  entry: RunEntry;
  part(ref: PartRef): Part | null;
  toolCall(message: number, part: number): NumberedToolCall | undefined;
  /** The call a tool return or retry prompt answers, or undefined when unpaired. */
  resultOf(message: number, part: number): NumberedToolCall | undefined;
  /** The recorded runs a tool call started. */
  childRuns(info: ToolCallInfo): RunEntry[];
  /** The recorded runs this run started outside a tool call. */
  nestedRuns: RunEntry[];
  responseCost(message: number): string | null;
}

export interface TrajectoryIndex {
  entries: Map<string, RunEntry>;
  /** Top-level runs, including runs whose parent is not recorded, in tree order. */
  roots: RunEntry[];
  /** In tree order: by the tool calls that started them, else by start time. */
  children(runId: string): RunEntry[];
  /** The recorded ancestors of a run, outermost first. */
  ancestors(runId: string): RunEntry[];
}

export function indexTrajectory(payload: TracePayload): TrajectoryIndex {
  const entries = new Map<string, RunEntry>();
  payload.trajectory.runs.forEach((run, i) => {
    entries.set(run.id, { run, analysis: payload.analysis.runs[i] });
  });
  const recorded = (ids: readonly string[]) =>
    ids.map((id) => entries.get(id)).filter((entry) => entry !== undefined);
  // A run ID may be any string, including "", so an absent parent is `undefined`.
  const parentOf = (entry: RunEntry): RunEntry | undefined =>
    entry.run.parent === null ? undefined : entries.get(entry.run.parent.run_id);
  return {
    entries,
    roots: recorded(payload.analysis.root_run_ids),
    children: (runId) => recorded(entries.get(runId)?.analysis.child_run_ids ?? []),
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
  const numbered = entry.analysis.tool_calls.map((info, i) => ({ number: i + 1, info }));
  const toolCalls = new Map(
    numbered.map((call) => [key(call.info.call.message, call.info.call.part), call]),
  );
  const byResult = new Map(
    numbered.flatMap((call) => {
      const result = call.info.result;
      return result === null ? [] : [[key(result.message, result.part), call] as const];
    }),
  );
  const costs = new Map(entry.analysis.responses.map((info) => [info.message, info.cost_usd]));
  const recorded = (ids: readonly string[]) =>
    ids.map((id) => trajectory.entries.get(id)).filter((run) => run !== undefined);
  return {
    entry,
    part: (ref) => entry.run.messages[ref.message]?.parts[ref.part] ?? null,
    toolCall: (message, part) => toolCalls.get(key(message, part)),
    resultOf: (message, part) => byResult.get(key(message, part)),
    childRuns: (info) => recorded(info.child_run_ids),
    nestedRuns: recorded(entry.analysis.nested_run_ids),
    responseCost: (message) => costs.get(message) ?? null,
  };
}
