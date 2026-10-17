import { ChevronRight } from "lucide-preact";
import { Fragment } from "preact";
import type { RunEntry, TrajectoryIndex } from "../runIndex";

/** `file › parent › run`: where the selected run sits, with each ancestor one click away. */
export function RunBreadcrumb({
  title,
  trajectory,
  selected,
  onSelect,
}: {
  title: string;
  trajectory: TrajectoryIndex | null;
  selected: RunEntry | null;
  onSelect: (runId: string) => void;
}) {
  if (trajectory === null || selected === null || trajectory.entries.size < 2) {
    return <span class="trace-title">{title}</span>;
  }
  // Flat children, so each name shrinks on its own and the separators never do.
  return (
    <nav class="trace-title breadcrumb" aria-label="Run path">
      <span>{title}</span>
      {trajectory.ancestors(selected.run.id).map((ancestor) => (
        <Fragment key={ancestor.run.id}>
          <ChevronRight size={13} />
          <button type="button" class="breadcrumb-link" onClick={() => onSelect(ancestor.run.id)}>
            {ancestor.run.name}
          </button>
        </Fragment>
      ))}
      <ChevronRight size={13} />
      <span aria-current="page">{selected.run.name}</span>
    </nav>
  );
}
