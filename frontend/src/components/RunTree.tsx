import { Ban, Bot, TriangleAlert, Unlink, Workflow } from "lucide-preact";
import { formatCount, formatDuration, formatTotalsCost } from "../format";
import { cn } from "../lib/utils";
import type { RunEntry, RunTreeIndex } from "../runIndex";
import { ICON_CLASS, TREE_CHILDREN_CLASS, treeRowClass } from "./TreePane";

/**
 * The run tree's runs, styled as sidebar tree rows so they can nest under
 * the file that holds them.
 */
export function RunTree({
  runTree,
  selected,
  onSelect,
}: {
  runTree: RunTreeIndex;
  selected: string;
  onSelect: (runId: string) => void;
}) {
  return (
    <div role="group" aria-label="Runs">
      {runTree.roots.map((entry) => (
        <RunNode
          key={entry.run.id}
          entry={entry}
          runTree={runTree}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function RunNode({
  entry,
  runTree,
  selected,
  onSelect,
}: {
  entry: RunEntry;
  runTree: RunTreeIndex;
  selected: string;
  onSelect: (runId: string) => void;
}) {
  const { run, analysis } = entry;
  const children = runTree.children(run.id);
  const cost = formatTotalsCost(analysis.subtree_totals);
  const isSelected = run.id === selected;
  return (
    <div>
      <button
        type="button"
        // A selected run is a position within the selected file: instead of the file's
        // full highlight, it gets bold text and a segment on the tree's guide line.
        class={cn(
          treeRowClass({ selected: isSelected }),
          "relative overflow-visible",
          isSelected &&
            "bg-transparent before:absolute before:inset-y-0 before:-left-1.25 before:w-px before:bg-foreground",
        )}
        aria-current={isSelected ? "true" : undefined}
        title={runSummary(entry)}
        onClick={() => onSelect(run.id)}
      >
        <span
          class={cn(
            ICON_CLASS,
            run.outcome.status === "failed" && "text-destructive-foreground",
            run.outcome.status === "cancelled" && "text-muted-foreground",
          )}
        >
          <RunIcon entry={entry} />
        </span>
        <span class="truncate">{run.name}</span>
        {cost !== null ? (
          <span class="ml-auto text-[11px] text-muted-foreground">{cost}</span>
        ) : null}
      </button>
      {children.length > 0 ? (
        <div class={TREE_CHILDREN_CLASS}>
          {children.map((child) => (
            <RunNode
              key={child.run.id}
              entry={child}
              runTree={runTree}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Problems replace the kind icon, like an invalid file in the file tree. */
function RunIcon({ entry }: { entry: RunEntry }) {
  const { run, analysis } = entry;
  if (run.outcome.status === "failed") return <TriangleAlert size={14} />;
  if (run.outcome.status === "cancelled") return <Ban size={14} />;
  if (analysis.parent_missing) return <Unlink size={14} />;
  return run.parent === null ? <Workflow size={14} /> : <Bot size={14} />;
}

function runSummary({ run, analysis }: RunEntry): string {
  const totals = analysis.subtree_totals;
  const lines = [
    run.name,
    `${formatCount(totals.llm_calls)} LLM calls · ${formatDuration(totals.duration_seconds)}`,
  ];
  if (run.outcome.status === "failed") {
    lines.push(`failed: ${run.outcome.error_type}: ${run.outcome.detail}`);
  }
  if (run.outcome.status === "cancelled") lines.push("cancelled");
  if (analysis.parent_missing) lines.push("parent not recorded");
  return lines.join("\n");
}
