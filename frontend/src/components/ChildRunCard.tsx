import { Bot } from "lucide-preact";
import { formatTotalsCost } from "../format";
import type { RunEntry } from "../runIndex";

/** A run started from here, summarized; opening it shows its own messages. */
export function ChildRunCard({
  entry,
  onOpen,
}: {
  entry: RunEntry;
  onOpen: (runId: string) => void;
}) {
  const totals = entry.analysis.subtree_totals;
  const cost = formatTotalsCost(totals);
  return (
    <button type="button" class="child-run" onClick={() => onOpen(entry.run.id)}>
      <Bot size={13} />
      <span class="tool-name">{entry.run.name}</span>
      <OutcomeBadge status={entry.run.outcome.status} />
      <span class="child-run-stats">
        {totals.llm_calls} calls
        {cost !== null ? ` · ${cost}` : ""}
      </span>
      <span class="preview-more">open</span>
    </button>
  );
}

/** Only problems are badged — completion is the unremarkable default. */
export function OutcomeBadge({ status }: { status: "completed" | "failed" | "cancelled" }) {
  if (status === "failed") return <span class="badge error">failed</span>;
  if (status === "cancelled") return <span class="badge warn">cancelled</span>;
  return null;
}
