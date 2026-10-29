import { useMemo } from "preact/hooks";
import {
  cacheHitRate,
  formatCount,
  formatDuration,
  formatPercent,
  formatTotalsCost,
} from "../format";
import { indexRun, type RunEntry, type RunTreeIndex } from "../runIndex";
import type { Totals } from "../types";
import { ChildRunCard } from "./ChildRunCard";
import { BANNER_CLASS, MessageCard, Note } from "./MessageCard";
import { Alert, AlertTitle } from "./ui/alert";

/** One run's messages in order, with the runs it started inline under their tool calls. */
export function TraceView({
  entry,
  runTree,
  onOpenRun,
}: {
  entry: RunEntry;
  runTree: RunTreeIndex;
  onOpenRun: (runId: string) => void;
}) {
  const index = useMemo(() => indexRun(entry, runTree), [entry, runTree]);
  const runStartMs = Date.parse(entry.run.started_at);
  let lastInstructions: string | null = null;
  return (
    <div>
      {entry.run.outcome.status === "failed" ? (
        <Alert variant="error" className={BANNER_CLASS} role="note">
          <AlertTitle>
            Run failed with {entry.run.outcome.error_type}: {entry.run.outcome.detail}
          </AlertTitle>
        </Alert>
      ) : null}
      {entry.analysis.parent_missing && entry.run.parent !== null ? (
        <Note className={BANNER_CLASS}>
          This run's parent, run {JSON.stringify(entry.run.parent.run_id)}, is not recorded in this
          trace yet.
        </Note>
      ) : null}
      {entry.run.outcome.status === "cancelled" ? (
        <Note className={BANNER_CLASS}>This run was cancelled.</Note>
      ) : null}
      {entry.run.messages.map((message, i) => {
        // Show instructions only where they change, as the transcript does.
        let instructions: string | null = null;
        if (message.kind === "request" && message.instructions !== lastInstructions) {
          instructions = message.instructions || null;
          if (instructions !== null) lastInstructions = instructions;
        }
        return (
          <MessageCard
            key={i}
            message={message}
            messageIndex={i}
            run={index}
            onOpenRun={onOpenRun}
            instructions={instructions}
            runStartMs={runStartMs}
          />
        );
      })}
      {index.nestedRuns.map((child) => (
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
  subtreeTotals: Totals;
}) {
  const tokens = totals.tokens;
  const hitRate = cacheHitRate(tokens.input, tokens.cache_read);
  const cost = formatTotalsCost(totals);
  const withSubruns = subtreeTotals.llm_calls !== totals.llm_calls ? subtreeTotals : null;
  const subtreeCost = withSubruns ? formatTotalsCost(withSubruns) : null;
  // When the header runs out of room, stats drop from the end: the token
  // breakdown goes before the run's calls, cost, and wall time. Stats that do not
  // fit wrap onto a second line, which the fixed height hides.
  return (
    <div class="trace-stats flex h-4.5 min-w-0 flex-[1_1_0] flex-wrap gap-3 overflow-hidden text-xs/4.5 whitespace-nowrap text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
      <span>
        <b>{formatCount(totals.llm_calls)}</b> LLM calls
      </span>
      {cost !== null ? (
        <span>
          <b>{cost}</b>
        </span>
      ) : null}
      <span>
        <b>{formatDuration(totals.duration_seconds)}</b> wall time
      </span>
      {withSubruns ? (
        <span title="This run plus every run it started">
          with subruns: <b>{formatCount(withSubruns.llm_calls)}</b> calls
          {subtreeCost !== null ? (
            <>
              , <b>{subtreeCost}</b>
            </>
          ) : null}
        </span>
      ) : null}
      <span class="trace-token-summary" aria-label="Token usage">
        <b>{formatCount(tokens.input)}</b> in
      </span>
      <span class="trace-token-summary">
        <b>{formatCount(tokens.cache_read)}</b> cached
        {hitRate !== null ? ` (${formatPercent(hitRate)})` : ""}
      </span>
      <span class="trace-token-summary">
        <b>{formatCount(tokens.output)}</b> out
      </span>
    </div>
  );
}
