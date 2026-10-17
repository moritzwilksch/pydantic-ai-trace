import { CornerDownRight, Ellipsis, FileText, Folder, TriangleAlert } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { defaultSelection, isMultiTrace } from "../selection";
import type { TraceSelection, TreeNode } from "../types";

/** JSONL traces listed per page: evaluation logs can hold many thousands. */
export const TRACE_LINE_PAGE = 100;

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
  /** Nested under the selected trace, such as the runs of a trajectory. */
  selectedChildren?: ComponentChildren;
}) {
  const [filter, setFilter] = useState("");
  const query = filter.trim().toLowerCase();
  const visibleRoot = query ? filterTree(root, query) : root;
  const topLevel =
    visibleRoot?.type === "dir" ? (visibleRoot.children ?? []) : visibleRoot ? [visibleRoot] : [];
  return (
    <nav class="tree-pane" id={id}>
      <div class="tree-header" title={rootLabel}>
        {rootLabel}
      </div>
      <input
        class="tree-filter"
        type="search"
        placeholder="Filter traces…"
        value={filter}
        onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
      />
      <div class="tree-body">
        {topLevel.length > 0 ? (
          topLevel.map((node) => (
            <NodeView
              key={node.path}
              node={node}
              selection={selection}
              onSelect={onSelect}
              selectedChildren={selectedChildren}
            />
          ))
        ) : (
          <div class="tree-empty">No traces match “{filter}”.</div>
        )}
      </div>
    </nav>
  );
}

function NodeView({
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
  if (node.type === "dir") {
    return (
      <div>
        <div class="tree-node">
          <span class="icon">
            <Folder size={14} />
          </span>
          {node.name}
        </div>
        <div class="tree-children">
          {(node.children ?? []).map((child) => (
            <NodeView
              key={child.path}
              node={child}
              selection={selection}
              onSelect={onSelect}
              selectedChildren={selectedChildren}
            />
          ))}
        </div>
      </div>
    );
  }

  const multiTrace = isMultiTrace(node);
  const target = defaultSelection(node);
  return (
    <div>
      <FileButton node={node} target={target} selection={selection} onSelect={onSelect} />
      {target && isSelected(selection, target.path, target.line) ? (
        <NestedUnderSelection>{selectedChildren}</NestedUnderSelection>
      ) : null}
      {multiTrace ? (
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
  const count = node.trace_count ?? 0;
  const listed = Math.min(shown, count);
  const lines = Array.from({ length: listed }, (_, i) => i + 1);
  const selectedLine = selection?.path === node.path ? selection.line : undefined;
  if (selectedLine !== undefined && selectedLine > listed && selectedLine <= count) {
    lines.push(selectedLine);
  }
  const hidden = count - listed;
  return (
    <div class="tree-children">
      {lines.map((line) => (
        <div key={line}>
          <button
            class={`tree-node ${isSelected(selection, node.path, line) ? "selected" : ""}`}
            onClick={() => onSelect({ path: node.path, line })}
          >
            <span class="icon">
              <CornerDownRight size={12} />
            </span>
            trace {line}
          </button>
          {isSelected(selection, node.path, line) ? (
            <NestedUnderSelection>{selectedChildren}</NestedUnderSelection>
          ) : null}
        </div>
      ))}
      {hidden > 0 ? (
        <button class="tree-node tree-more" onClick={() => setShown(listed + TRACE_LINE_PAGE)}>
          <span class="icon">
            <Ellipsis size={12} />
          </span>
          show {Math.min(hidden, TRACE_LINE_PAGE)} more of {hidden}
        </button>
      ) : null}
    </div>
  );
}

function NestedUnderSelection({ children }: { children: ComponentChildren }) {
  return children ? <div class="tree-children">{children}</div> : null;
}

function FileButton({
  node,
  target,
  selection,
  onSelect,
}: {
  node: TreeNode;
  /** How clicking opens this file; null when it can't be opened directly. */
  target: TraceSelection | null;
  selection: TraceSelection | null;
  onSelect: (selection: TraceSelection) => void;
}) {
  return (
    <button
      class={`tree-node ${node.error ? "error" : ""} ${
        target && isSelected(selection, target.path, target.line) ? "selected" : ""
      }`}
      aria-invalid={node.error || undefined}
      title={node.error ? (node.error_message ?? "File could not be parsed") : node.path}
      onClick={() => {
        if (target) onSelect(target);
        else if (node.error) onSelect({ path: node.path });
      }}
    >
      <span class="icon">{node.error ? <TriangleAlert size={14} /> : <FileText size={14} />}</span>
      {node.name}
      {node.format === "jsonl" ? <span class="count">{node.trace_count}</span> : null}
      {node.error ? <span class="tree-error-label">invalid</span> : null}
    </button>
  );
}

function isSelected(selection: TraceSelection | null, path: string, line?: number): boolean {
  return selection !== null && selection.path === path && selection.line === line;
}

function filterTree(node: TreeNode, query: string): TreeNode | null {
  if (node.type === "file") {
    return node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query)
      ? node
      : null;
  }
  const children = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNode => child !== null);
  if (children.length === 0 && !node.name.toLowerCase().includes(query)) return null;
  return { ...node, children };
}
