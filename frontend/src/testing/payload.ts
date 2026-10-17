// Test-only builders for `TracePayload`s. Production payloads come from Python;
// these fill the canonical defaults Pydantic AI would dump and a minimal analysis
// (chronological pairing, token totals, no prices) so component tests stay short.

import { parseJson } from "../json";
import type {
  Message,
  PartRef,
  Run,
  RunAnalysis,
  ToolCallInfo,
  Totals,
  TracePayload,
} from "../types";

const START = "2026-07-01T09:00:00Z";

export interface RunSpec {
  id?: string;
  name?: string;
  messages: unknown[];
  parent?: { run_id: string; tool_call_id: string | null } | null;
  outcome?: Run["outcome"];
}

export function payloadFromMessages(
  messages: unknown[],
  options: { name?: string; transcript?: string } = {},
): TracePayload {
  return payloadFromRuns([{ id: "run", name: "run", messages }], options);
}

export function payloadFromRuns(
  specs: RunSpec[],
  { name = "trace", transcript = "" }: { name?: string; transcript?: string } = {},
): TracePayload {
  const runs = specs.map(buildRun);
  const analyses = runs.map((run) => analyzeRun(run, runs));
  return {
    name,
    trajectory: { runs: runs as [Run, ...Run[]] },
    analysis: { totals: sumTotals(analyses.map((a) => a.totals)), runs: analyses },
    transcript,
  };
}

/** Embed a payload the way `paitrace export` does. */
export function embed(payload: TracePayload): void {
  window.__TRACE_PAYLOAD__ = JSON.stringify(payload);
}

export function embedMessages(
  messages: unknown[],
  options: { name?: string; transcript?: string } = {},
): void {
  embed(payloadFromMessages(messages, options));
}

function buildRun(spec: RunSpec, index: number): Run {
  return {
    id: spec.id ?? `run-${index}`,
    name: spec.name ?? `run ${index}`,
    parent: spec.parent ?? null,
    started_at: START,
    ended_at: START,
    outcome: spec.outcome ?? { status: "completed", output: null },
    messages: spec.messages.map(withDefaults) as Run["messages"],
  };
}

function withDefaults(raw: unknown): Message {
  const message = raw as Record<string, unknown>;
  if (message.kind === "response") {
    return {
      timestamp: START,
      state: "complete",
      model_name: null,
      provider_name: null,
      finish_reason: null,
      ...message,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        ...(message.usage as object),
      },
    } as unknown as Message;
  }
  return {
    timestamp: null,
    instructions: null,
    state: "complete",
    ...message,
  } as unknown as Message;
}

function analyzeRun(run: Run, runs: Run[]): RunAnalysis {
  const pending = new Map<string, number[]>();
  const calls: ToolCallInfo[] = [];
  const matched: PartRef[] = [];
  run.messages.forEach((message, m) =>
    message.parts.forEach((part, p) => {
      const callId = (part as { tool_call_id?: string }).tool_call_id;
      if (part.part_kind === "tool-call" || part.part_kind === "builtin-tool-call") {
        const args = (part as { args?: unknown }).args;
        calls.push({
          call: { message: m, part: p },
          args: typeof args === "string" ? parseOr(args) : (args ?? null),
          result: null,
          is_output: false,
          child_run_ids: runs
            .filter(
              (child) => child.parent?.run_id === run.id && child.parent.tool_call_id === callId,
            )
            .map((child) => child.id),
        });
        pending.set(callId!, [...(pending.get(callId!) ?? []), calls.length - 1]);
      } else if (callId !== undefined && callId !== null) {
        const waiting = pending.get(callId);
        if (!waiting?.length) return;
        const info = calls[waiting.shift()!];
        info.result = { message: m, part: p };
        // Mirrors `FINAL_RESULT_STATUS` in `analysis.py`.
        info.is_output =
          part.part_kind === "tool-return" &&
          (part as { content?: unknown }).content === "Final result processed.";
        matched.push({ message: m, part: p });
      }
    }),
  );
  const responses = run.messages.flatMap((message, m) =>
    message.kind === "response" ? [{ message: m, cost_usd: null }] : [],
  );
  const totals = runTotals(run);
  return {
    run_id: run.id,
    parent_missing: run.parent !== null && !runs.some((r) => r.id === run.parent!.run_id),
    totals,
    subtree_totals: totals,
    responses,
    tool_calls: calls,
    matched_results: matched,
    nested_run_ids: runs
      .filter((child) => child.parent?.run_id === run.id && child.parent.tool_call_id === null)
      .map((child) => child.id),
  };
}

function runTotals(run: Run): Totals {
  const responses = run.messages.filter((message) => message.kind === "response");
  const sum = (key: "input_tokens" | "output_tokens" | "cache_read_tokens") =>
    responses.reduce((total, response) => total + (response.usage[key] ?? 0), 0);
  return {
    llm_calls: responses.length,
    tokens: {
      input: sum("input_tokens"),
      output: sum("output_tokens"),
      cache_read: sum("cache_read_tokens"),
      cache_write: 0,
    },
    cost_usd: null,
    unpriced_calls: 0,
    duration_seconds: 0,
  };
}

function sumTotals(items: Totals[]): Totals {
  return {
    llm_calls: items.reduce((n, t) => n + t.llm_calls, 0),
    tokens: {
      input: items.reduce((n, t) => n + t.tokens.input, 0),
      output: items.reduce((n, t) => n + t.tokens.output, 0),
      cache_read: items.reduce((n, t) => n + t.tokens.cache_read, 0),
      cache_write: 0,
    },
    cost_usd: null,
    unpriced_calls: 0,
    duration_seconds: 0,
  };
}

function parseOr(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return text;
  }
}
