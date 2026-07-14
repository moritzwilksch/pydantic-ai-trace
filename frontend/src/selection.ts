// The one place that decides how a tree node opens: jsonl files with several
// traces need an explicit per-trace choice; everything else opens directly.

import type { TraceSelection, TreeNode } from "./types";

export function isMultiTrace(node: TreeNode): boolean {
  return node.format === "jsonl" && (node.trace_count ?? 0) > 1;
}

/** The selection that opens `node` directly, or null when it can't (broken or multi-trace). */
export function defaultSelection(node: TreeNode): TraceSelection | null {
  if (node.type !== "file" || node.error || isMultiTrace(node)) return null;
  return { path: node.path, line: node.format === "jsonl" ? 1 : undefined };
}
