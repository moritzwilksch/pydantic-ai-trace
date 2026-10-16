import { useMemo } from "preact/hooks";
import { cacheHitRate, formatCost } from "../format";
import { indexRun, type RunEntry, type TrajectoryIndex } from "../runIndex";
import type { Totals } from "../types";
import { ChildRunCard } from "./ChildRunCard";
import { formatCount, MessageCard } from "./MessageCard";

/** One run's messages in order, with the runs it started inline under their tool calls. */
export function TraceView({
  entry,
  trajectory,
  onOpenRun,
}: {
  entry: RunEntry;
  trajectory: TrajectoryIndex;
  onOpenRun: (runId: string) => void;
}) {
  const index = useMemo(() => indexRun(entry), [entry]);
  const runStartMs = Date.parse(entry.run.started_at);
  const nested = entry.analysis.nested_run_ids
    .map((id) => trajectory.entries.get(id))
    .filter((child): child is RunEntry => child !== undefined);
  let lastInstructions: string | null = null;
  return (
    <div>
      {entry.run.outcome.status === "failed" ? (
        <div class="banner-error" role="note">
          Run failed with {entry.run.outcome.error_type}: {entry.run.outcome.detail}
        </div>
      ) : null}
      {entry.run.outcome.status === "cancelled" ? (
        <div class="interrupted-message" role="note">
          This run was cancelled.
        </div>
      ) : null}
      {entry.run.messages.map((message, i) => {
        const showInstructions =
          message.kind === "request" &&
          Boolean(message.instructions) &&
          message.instructions !== lastInstructions;
        if (showInstructions && message.kind === "request") {
          lastInstructions = message.instructions ?? null;
        }
        return (
          <MessageCard
            key={i}
            message={message}
            messageIndex={i}
            run={index}
            trajectory={trajectory}
            onOpenRun={onOpenRun}
            showInstructions={showInstructions}
            runStartMs={Number.isNaN(runStartMs) ? null : runStartMs}
          />
        );
      })}
      {nested.map((child) => (
        <ChildRunCard key={child.run.id} entry={child} onOpen={onOpenRun} />
      ))}
    </div>
  );
}

export function TraceStatsBar({
  totals,
  subtreeTotals,
}: {
  totals: Totals;
  /** Shown when the run has descendants whose cost adds to its own. */
  subtreeTotals?: Totals;
}) {
  const tokens = totals.tokens;
  const hitRate = cacheHitRate(tokens.input, tokens.cache_read);
  const withSubruns =
    subtreeTotals !== undefined && subtreeTotals.llm_calls !== totals.llm_calls
      ? subtreeTotals
      : null;
  return (
    <div class="trace-stats">
      <span>
        <b>{totals.llm_calls}</b> LLM calls
      </span>
      <span class="trace-token-summary" aria-label="Token usage">
        <b>{formatCount(tokens.input)}</b> in
      </span>
      <span class="trace-token-summary">
        <b>{formatCount(tokens.cache_read)}</b> cached
        {hitRate !== null ? ` (${hitRate.toFixed(1)}%)` : ""}
      </span>
      <span class="trace-token-summary">
        <b>{formatCount(tokens.output)}</b> out
      </span>
      <CostSummary totals={totals} />
      <span>
        <b>{totals.duration_seconds.toFixed(1)}s</b> wall time
      </span>
      {withSubruns ? (
        <span title="This run plus every run it started">
          with subruns: <b>{withSubruns.llm_calls}</b> calls
          {withSubruns.cost_usd !== null ? (
            <>
              , <b>{formatCost(withSubruns.cost_usd)}</b>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** A partial sum is labelled, so unknown model prices never read as free. */
function CostSummary({ totals }: { totals: Totals }) {
  if (totals.cost_usd === null) {
    return totals.unpriced_calls > 0 ? (
      <span title="No price known for these models">cost unknown</span>
    ) : null;
  }
  return (
    <span>
      <b>{formatCost(totals.cost_usd)}</b>
      {totals.unpriced_calls > 0 ? ` (+${totals.unpriced_calls} unpriced)` : ""}
    </span>
  );
}
