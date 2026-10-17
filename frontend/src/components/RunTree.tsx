import { Ban, Bot, TriangleAlert, Unlink, Workflow } from "lucide-preact";
import { formatCount, formatDuration, formatTotalsCost } from "../format";
import type { RunEntry, TrajectoryIndex } from "../runIndex";

/**
 * The trajectory's runs, styled as sidebar tree rows so they can nest under
 * the file that holds them.
 */
export function RunTree({
  trajectory,
  selected,
  onSelect,
}: {
  trajectory: TrajectoryIndex;
  selected: string;
  onSelect: (runId: string) => void;
}) {
  return (
    <div role="group" aria-label="Runs">
      {trajectory.roots.map((entry) => (
        <RunNode
          key={entry.run.id}
          entry={entry}
          trajectory={trajectory}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function RunNode({
  entry,
  trajectory,
  selected,
  onSelect,
}: {
  entry: RunEntry;
  trajectory: TrajectoryIndex;
  selected: string;
  onSelect: (runId: string) => void;
}) {
  const { run, analysis } = entry;
  const children = trajectory.children(run.id);
  const cost = formatTotalsCost(analysis.subtree_totals);
  const isSelected = run.id === selected;
  return (
    <div>
      <button
        type="button"
        class={`tree-node run-node ${run.outcome.status} ${isSelected ? "selected" : ""}`}
        aria-current={isSelected ? "true" : undefined}
        title={runSummary(entry)}
        onClick={() => onSelect(run.id)}
      >
        <span class="icon">
          <RunIcon entry={entry} />
        </span>
        <span class="run-name">{run.name}</span>
        {cost !== null ? <span class="count">{cost}</span> : null}
      </button>
      {children.length > 0 ? (
        <div class="tree-children">
          {children.map((child) => (
            <RunNode
              key={child.run.id}
              entry={child}
              trajectory={trajectory}
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
