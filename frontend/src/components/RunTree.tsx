import { formatCost } from "../format";
import type { RunEntry, TrajectoryIndex } from "../runIndex";
import { OutcomeBadge } from "./ChildRunCard";

/** The trajectory's runs as a tree; nothing for a single-run trace. */
export function RunTree({
  trajectory,
  selected,
  onSelect,
}: {
  trajectory: TrajectoryIndex;
  selected: string;
  onSelect: (runId: string) => void;
}) {
  if (trajectory.entries.size < 2) return null;
  return (
    <nav class="run-tree" aria-label="Runs">
      {trajectory.roots.map((entry) => (
        <RunNode
          key={entry.run.id}
          entry={entry}
          trajectory={trajectory}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </nav>
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
  const children = trajectory.children(entry.run.id);
  const cost = entry.analysis.subtree_totals.cost_usd;
  return (
    <div>
      <button
        type="button"
        class={`tree-node${entry.run.id === selected ? " selected" : ""}`}
        aria-current={entry.run.id === selected ? "true" : undefined}
        onClick={() => onSelect(entry.run.id)}
      >
        <span class="run-name">{entry.run.name}</span>
        <OutcomeBadge status={entry.run.outcome.status} />
        {entry.analysis.parent_missing ? (
          <span class="badge warn" title="This run names a parent the trace does not contain yet">
            parent not recorded
          </span>
        ) : null}
        {cost !== null ? <span class="count">{formatCost(cost)}</span> : null}
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
