import { Fragment } from "preact";
import type { RunEntry, RunTreeIndex } from "../runIndex";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb";

/** Takes its full width first; the header's stats get only the space left over. */
const TITLE_CLASS = "trace-title min-w-0 flex-[0_1_auto] text-[13px] font-semibold";

/** `file › parent › run`: where the selected run sits, with each ancestor one click away. */
export function RunBreadcrumb({
  title,
  runTree,
  selected,
  onSelect,
}: {
  title: string;
  runTree: RunTreeIndex | null;
  selected: RunEntry | null;
  onSelect: (runId: string) => void;
}) {
  if (runTree === null || selected === null || runTree.entries.size < 2) {
    return <span class={`${TITLE_CLASS} truncate`}>{title}</span>;
  }
  // When space runs out, the file and the ancestors truncate; the selected run keeps
  // its full name while it fits.
  return (
    <Breadcrumb aria-label="Run path" className={TITLE_CLASS}>
      <BreadcrumbList className="flex-nowrap gap-1 text-[13px] sm:gap-1">
        <BreadcrumbItem className="min-w-0 text-foreground">
          <span class="truncate">{title}</span>
        </BreadcrumbItem>
        {runTree.ancestors(selected.run.id).map((ancestor) => (
          <Fragment key={ancestor.run.id}>
            <BreadcrumbSeparator className="[&>svg]:size-3.5" />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbLink
                className="cursor-pointer truncate font-semibold"
                render={<button type="button" />}
                onClick={() => onSelect(ancestor.run.id)}
              >
                {ancestor.run.name}
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
        <BreadcrumbSeparator className="[&>svg]:size-3.5" />
        <BreadcrumbItem className="max-w-full shrink-0">
          <BreadcrumbPage className="truncate font-semibold">{selected.run.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
