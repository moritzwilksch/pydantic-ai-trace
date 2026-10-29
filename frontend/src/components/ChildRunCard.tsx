import { Bot } from "lucide-preact";
import { formatCount, formatTotalsCost } from "../format";
import type { RunEntry } from "../runIndex";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

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
    <Button
      variant="outline"
      size="sm"
      className="child-run mx-auto mt-1.5 flex w-full max-w-275 justify-start text-xs font-normal sm:text-xs"
      onClick={() => onOpen(entry.run.id)}
    >
      <Bot />
      <span class="tool-name font-mono font-semibold text-tool">{entry.run.name}</span>
      <OutcomeBadge status={entry.run.outcome.status} />
      <span class="ml-auto text-muted-foreground">
        {formatCount(totals.llm_calls)} calls
        {cost !== null ? ` · ${cost}` : ""}
      </span>
      <span class="text-[10px] font-medium text-muted-foreground">open</span>
    </Button>
  );
}

/** Only problems are badged — completion is the unremarkable default. */
function OutcomeBadge({ status }: { status: "completed" | "failed" | "cancelled" }) {
  if (status === "failed") return <Badge variant="error">failed</Badge>;
  if (status === "cancelled") return <Badge variant="warning">cancelled</Badge>;
  return null;
}
