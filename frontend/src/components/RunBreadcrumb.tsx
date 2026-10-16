import { ChevronRight } from "lucide-preact";
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
  return (
    <nav class="trace-title breadcrumb" aria-label="Run path">
      <span>{title}</span>
      {trajectory.ancestors(selected.run.id).map((ancestor) => (
        <span key={ancestor.run.id} class="breadcrumb-step">
          <ChevronRight size={13} />
          <button type="button" class="breadcrumb-link" onClick={() => onSelect(ancestor.run.id)}>
            {ancestor.run.name}
          </button>
        </span>
      ))}
      <span class="breadcrumb-step">
        <ChevronRight size={13} />
        <span aria-current="page">{selected.run.name}</span>
      </span>
    </nav>
  );
}
