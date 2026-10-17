// The one place that decides how a tree node opens (jsonl files with several
// traces need an explicit per-trace choice) and how the URL hash names a view.

import type { TraceSelection, TreeNode } from "./types";

export function isMultiTrace(node: TreeNode): boolean {
  return node.format === "jsonl" && (node.trace_count ?? 0) > 1;
}

/** The selection that opens `node` directly, or null when it can't (broken or multi-trace). */
export function defaultSelection(node: TreeNode): TraceSelection | null {
  if (node.type !== "file" || node.error || isMultiTrace(node)) return null;
  return { path: node.path, line: node.format === "jsonl" ? 1 : undefined };
}

/**
 * What the URL hash names: a trace (server viewer only) and a run within it.
 * An absent `run` means the trace's first root run.
 */
export interface ViewLocation {
  trace: TraceSelection | null;
  run?: string;
}

/** Parses `#/<path>[:<line>][?run=<id>]`; exported HTML uses `#?run=<id>`. */
export function parseHash(hash: string): ViewLocation {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  // formatHash encodes `?` in paths, so the first one starts the query.
  const queryStart = body.indexOf("?");
  const tracePart = queryStart === -1 ? body : body.slice(0, queryStart);
  const query = new URLSearchParams(queryStart === -1 ? "" : body.slice(queryStart + 1));
  return { trace: parseTrace(tracePart), run: query.get("run") ?? undefined };
}

export function formatHash({ trace, run }: ViewLocation): string {
  const path = trace ? `/${trace.path.split("/").map(encodeURIComponent).join("/")}` : "";
  const line = trace?.line !== undefined ? `:${trace.line}` : "";
  const query = run !== undefined ? `?${new URLSearchParams({ run })}` : "";
  return `#${path}${line}${query}`;
}

function parseTrace(text: string): TraceSelection | null {
  if (!text.startsWith("/") || text.length <= 1) return null;
  // Split off the line before decoding so `:` and `%` in file names can't confuse parsing.
  const match = /^(.*?)(?::(\d+))?$/.exec(text.slice(1));
  if (!match) return null;
  let path = match[1];
  try {
    path = decodeURIComponent(path);
  } catch {
    // hand-typed hash with a stray '%' — use it verbatim
  }
  return { path, line: match[2] !== undefined ? Number(match[2]) : undefined };
}

export function sameSelection(a: TraceSelection | null, b: TraceSelection | null): boolean {
  return a === b || (a !== null && b !== null && a.path === b.path && a.line === b.line);
}
