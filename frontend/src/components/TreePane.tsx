import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Ellipsis,
  FileText,
  TriangleAlert,
} from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { cn } from "../lib/utils";
import { Brand } from "./Brand";
import { SIDEBAR_PANE_CLASS } from "./Sidebar";
import { Input } from "./ui/input";
import { defaultSelection, isMultiTrace } from "../selection";
import type { TraceSelection, TraceSummary, TreeNode } from "../types";

/** JSONL traces listed per page: evaluation logs can hold many thousands. */
export const TRACE_LINE_PAGE = 100;

export const TREE_BODY_CLASS = "tree-body flex-1 overflow-y-auto px-1.5 pb-3";

/** Nested rows, indented under a guide line; a selected run marks its segment of it. */
export const TREE_CHILDREN_CLASS = "tree-children ml-3.5 border-l pl-1";

/** One row of the sidebar tree: a folder, file, trace, or run. */
export function treeRowClass({ selected = false, error = false } = {}): string {
  return cn(
    "tree-node flex w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-2 py-0.75 text-left text-[13px] whitespace-nowrap hover:bg-accent",
    error && "text-muted-foreground hover:bg-destructive/8",
    selected && "selected bg-foreground/7 font-medium",
  );
}

/** Problems with a file or trace, at the row's right edge. */
const ERROR_LABEL_CLASS = "ml-auto text-[10px] font-semibold text-destructive-foreground";
export const ICON_CLASS = "inline-flex w-4 shrink-0 items-center justify-center";
const COUNT_CLASS = "ml-auto text-[11px] text-muted-foreground";

export function TreePane({
  id,
  root,
  rootLabel,
  selection,
  onSelect,
  selectedChildren,
}: {
  id?: string;
  root: TreeNode;
  rootLabel: string;
  selection: TraceSelection | null;
  onSelect: (selection: TraceSelection) => void;
  /** Nested under the selected trace, such as the runs of a run tree. */
  selectedChildren?: ComponentChildren;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const visibleRoot = query ? filterTree(root, query) : root;
  const topLevel =
    visibleRoot?.type === "dir" ? (visibleRoot.children ?? []) : visibleRoot ? [visibleRoot] : [];
  return (
    <nav class={SIDEBAR_PANE_CLASS} id={id}>
      <Brand />
      <TreeHeader label={rootLabel} />
      <Input
        nativeInput
        size="sm"
        className="mx-2.5 mb-2 w-auto"
        type="search"
        placeholder="Filter traces…"
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !visibleRoot) return;
          e.preventDefault();
          const first = firstEntry(visibleRoot);
          if (first) onSelect(first);
        }}
      />
      <div class={TREE_BODY_CLASS}>
        {topLevel.length > 0 ? (
          topLevel.map((node) => (
            <NodeView
              key={node.path}
              node={node}
              // A lone file is the whole tree, so its traces start listed.
              startOpen={root.type === "file"}
              filtering={query !== ""}
              selection={selection}
              onSelect={onSelect}
              selectedChildren={selectedChildren}
            />
          ))
        ) : (
          <div class="px-1.5 py-2 text-xs text-muted-foreground">No traces match “{filter}”.</div>
        )}
      </div>
    </nav>
  );
}

interface NodeProps {
  node: TreeNode;
  /** A filter lists every match, so it opens every node it keeps. */
  filtering: boolean;
  selection: TraceSelection | null;
  onSelect: (selection: TraceSelection) => void;
  selectedChildren: ComponentChildren;
}

/** A folder or file; folders and multi-trace files open and close. */
function NodeView({ startOpen, ...props }: NodeProps & { startOpen: boolean }) {
  const { node, filtering, selection, onSelect, selectedChildren } = props;
  const holdsSelection =
    selection !== null &&
    (node.type === "dir"
      ? selection.path.startsWith(`${node.path}/`)
      : selection.path === node.path);
  // Folders start open; a JSONL file's traces start hidden unless they hold the selection.
  const [open, setOpen] = useState(node.type === "dir" || startOpen || holdsSelection);
  // A selection made elsewhere, such as from the URL, reveals itself.
  useEffect(() => {
    if (holdsSelection) setOpen(true);
  }, [holdsSelection, selection?.path, selection?.line]);
  const shown = open || filtering;
  const toggle = () => setOpen(!open);

  if (node.type === "dir") {
    return (
      <div>
        <button class={treeRowClass()} aria-expanded={shown} onClick={toggle}>
          <Chevron open={shown} />
          {node.name}
        </button>
        {shown ? (
          <div class={TREE_CHILDREN_CLASS}>
            {(node.children ?? []).map((child) => (
              <NodeView key={child.path} {...props} node={child} startOpen={false} />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const multiTrace = isMultiTrace(node);
  const target = defaultSelection(node);
  return (
    <div>
      <FileButton
        node={node}
        selected={target !== null && isSelected(selection, target.path, target.line)}
        expanded={multiTrace ? shown : undefined}
        // A broken file still opens, so the viewer can explain the error.
        onClick={multiTrace ? toggle : () => onSelect(target ?? { path: node.path })}
      />
      {target && isSelected(selection, target.path, target.line) ? (
        <NestedUnderSelection>{selectedChildren}</NestedUnderSelection>
      ) : null}
      {multiTrace && shown ? (
        <TraceLines
          node={node}
          selection={selection}
          onSelect={onSelect}
          selectedChildren={selectedChildren}
        />
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span class={ICON_CLASS}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
  );
}

/** A JSONL file's traces, one page at a time; a selected later trace stays listed. */
function TraceLines({
  node,
  selection,
  onSelect,
  selectedChildren,
}: {
  node: TreeNode;
  selection: TraceSelection | null;
  onSelect: (selection: TraceSelection) => void;
  selectedChildren: ComponentChildren;
}) {
  const [shown, setShown] = useState(TRACE_LINE_PAGE);
  const traces = node.traces ?? [];
  const listed = traces.slice(0, shown);
  const selectedLine = selection?.path === node.path ? selection.line : undefined;
  const selectedTrace = traces.find((trace) => trace.line === selectedLine);
  if (selectedTrace && !listed.includes(selectedTrace)) listed.push(selectedTrace);
  const hidden = Math.max(0, traces.length - shown);
  return (
    <div class={TREE_CHILDREN_CLASS}>
      {listed.map((trace) => (
        <div key={trace.line}>
          <TraceButton
            trace={trace}
            selected={isSelected(selection, node.path, trace.line)}
            onClick={() => onSelect({ path: node.path, line: trace.line })}
          />
          {isSelected(selection, node.path, trace.line) ? (
            <NestedUnderSelection>{selectedChildren}</NestedUnderSelection>
          ) : null}
        </div>
      ))}
      {hidden > 0 ? (
        <button
          class={cn(treeRowClass(), "text-muted-foreground")}
          onClick={() => setShown(shown + TRACE_LINE_PAGE)}
        >
          <span class={ICON_CLASS}>
            <Ellipsis size={12} />
          </span>
          show {Math.min(hidden, TRACE_LINE_PAGE)} more of {hidden}
        </button>
      ) : null}
    </div>
  );
}

/** One JSONL trace, labelled by its line number and first prompt. */
function TraceButton({
  trace,
  selected,
  onClick,
}: {
  trace: TraceSummary;
  selected: boolean;
  onClick: () => void;
}) {
  const details = [`trace ${trace.line}`, ...trace.models].join(" · ");
  const ref = useRevealWhenSelected(selected);
  return (
    <button
      ref={ref}
      class={treeRowClass({ selected, error: trace.error })}
      aria-invalid={trace.error || undefined}
      title={
        trace.error
          ? (trace.error_message ?? "Trace could not be parsed")
          : [details, trace.prompt, trace.answer && `→ ${trace.answer}`].filter(Boolean).join("\n")
      }
      onClick={onClick}
    >
      <span class={ICON_CLASS}>
        {trace.error ? <TriangleAlert size={12} /> : <CornerDownRight size={12} />}
      </span>
      {trace.prompt ? (
        <>
          <span class="min-w-[2ch] shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            {trace.line}
          </span>
          <span class="min-w-0 truncate">{trace.prompt}</span>
        </>
      ) : (
        <span class="min-w-0 truncate">trace {trace.line}</span>
      )}
      {trace.error ? <span class={ERROR_LABEL_CLASS}>invalid</span> : null}
    </button>
  );
}

function NestedUnderSelection({ children }: { children: ComponentChildren }) {
  return children ? <div class={TREE_CHILDREN_CLASS}>{children}</div> : null;
}

function FileButton({
  node,
  selected,
  expanded,
  onClick,
}: {
  node: TreeNode;
  selected: boolean;
  /** Whether a multi-trace file lists its traces; undefined for other files. */
  expanded: boolean | undefined;
  onClick: () => void;
}) {
  const invalidTraces = node.error ? 0 : (node.traces ?? []).filter((t) => t.error).length;
  const ref = useRevealWhenSelected(selected);
  return (
    <button
      ref={ref}
      class={treeRowClass({ selected, error: node.error })}
      aria-invalid={node.error || undefined}
      aria-expanded={expanded}
      title={node.error ? (node.error_message ?? "File could not be parsed") : node.path}
      onClick={onClick}
    >
      {expanded !== undefined ? (
        <Chevron open={expanded} />
      ) : (
        <span class={ICON_CLASS}>
          {node.error ? <TriangleAlert size={14} /> : <FileText size={14} />}
        </span>
      )}
      <span class="min-w-0 truncate">{node.name}</span>
      {node.format === "jsonl" ? <span class={COUNT_CLASS}>{node.trace_count}</span> : null}
      {node.error ? <span class={ERROR_LABEL_CLASS}>invalid</span> : null}
      {invalidTraces > 0 ? <span class={ERROR_LABEL_CLASS}>{invalidTraces} invalid</span> : null}
    </button>
  );
}

/**
 * Center an entry that becomes selected out of view, such as from a deep link.
 * It runs once the entry renders, after its ancestors have expanded to show it.
 */
function useRevealWhenSelected(selected: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const entry = ref.current;
    const body = entry?.closest(".tree-body");
    if (selected && entry && body && !isWithin(entry, body)) {
      entry.scrollIntoView?.({ block: "center" });
    }
  }, [selected]);
  return ref;
}

function isWithin(element: Element, container: Element): boolean {
  const inner = element.getBoundingClientRect();
  const outer = container.getBoundingClientRect();
  return inner.top >= outer.top && inner.bottom <= outer.bottom;
}

/** What clicking the first listed entry opens: a file, or a JSONL file's first listed trace. */
function firstEntry(node: TreeNode): TraceSelection | null {
  if (node.type === "dir") {
    for (const child of node.children ?? []) {
      const entry = firstEntry(child);
      if (entry) return entry;
    }
    return null;
  }
  if (!isMultiTrace(node)) return defaultSelection(node) ?? { path: node.path };
  const first = node.traces?.[0];
  return first ? { path: node.path, line: first.line } : null;
}

function isSelected(selection: TraceSelection | null, path: string, line?: number): boolean {
  return selection !== null && selection.path === path && selection.line === line;
}

/** Keep nodes whose name or path matches, and files with a trace whose summary does. */
function filterTree(node: TreeNode, query: string): TreeNode | null {
  if (node.type === "file") {
    if (node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)) {
      return node;
    }
    const traces = (node.traces ?? []).filter((trace) => traceMatches(trace, query));
    return traces.length > 0 ? { ...node, traces } : null;
  }
  const children = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNode => child !== null);
  if (children.length === 0 && !node.name.toLowerCase().includes(query)) return null;
  return { ...node, children };
}

function traceMatches(trace: TraceSummary, query: string): boolean {
  return [trace.prompt, trace.answer, ...trace.models].some(
    (text) => text?.toLowerCase().includes(query) ?? false,
  );
}

/** The sidebar's heading: the served root, or the exported trace's name. */
export function TreeHeader({ label }: { label: string }) {
  return (
    <div class="truncate px-3 pt-2.5 pb-1.5 text-[13px] font-semibold" title={label}>
      {label}
    </div>
  );
}
