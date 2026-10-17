// What the server view shows for the selected trace, and how a load result changes it.

import type { TracePayload, TraceSelection } from "./types";

/** A loaded trace, with the selection it was loaded for. */
export interface ShownTrace {
  status: "ready";
  selection: TraceSelection;
  data: TracePayload;
}

/**
 * While the next trace loads, the previous one stays on screen, so nothing jumps.
 * A reload that fails, as while the file is half-written, keeps the last valid
 * version on screen as `stale`.
 */
export type TraceState =
  | { status: "unselected" }
  | { status: "loading"; previous: ShownTrace | null }
  | ShownTrace
  | { status: "stale"; shown: ShownTrace; message: string }
  | { status: "error"; message: string };

/** The state after loading `selection` failed with `message`. */
export function traceFailed(
  current: TraceState,
  selection: TraceSelection,
  message: string,
): TraceState {
  const shown = shownTrace(current);
  if (shown && sameSelection(shown.selection, selection)) {
    return { status: "stale", shown, message };
  }
  return { status: "error", message };
}

export function shownTrace(trace: TraceState): ShownTrace | null {
  switch (trace.status) {
    case "ready":
      return trace;
    case "loading":
      return trace.previous;
    case "stale":
      return trace.shown;
    default:
      return null;
  }
}

export function sameSelection(a: TraceSelection | null, b: TraceSelection | null): boolean {
  return a === b || (a !== null && b !== null && a.path === b.path && a.line === b.line);
}
