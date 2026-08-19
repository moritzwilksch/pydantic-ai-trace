// Data access: REST endpoints, SSE change feed, and the exported-HTML
// fallback where the trace is embedded as window.__TRACE_DATA__.

import type {
  EmbeddedTraceCollection,
  Meta,
  TracePayload,
  TraceSelection,
  TreeNode,
} from "./types";

declare global {
  interface Window {
    __TRACE_DATA__?: unknown;
    __TRACE_NAME__?: string;
    __TRACE_TEXT__?: string;
    __TRACE_COLLECTION__?: unknown;
  }
}

export function embeddedTraceCollection(): EmbeddedTraceCollection | null {
  if (window.__TRACE_COLLECTION__ === undefined) return null;
  let value = window.__TRACE_COLLECTION__;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<EmbeddedTraceCollection>;
  if (!Array.isArray(candidate.traces) || candidate.traces.length === 0) return null;
  if (
    !candidate.traces.every(
      (trace) =>
        trace &&
        typeof trace.name === "string" &&
        typeof trace.source === "string" &&
        typeof trace.transcript === "string",
    )
  ) {
    return null;
  }
  return {
    title: typeof candidate.title === "string" ? candidate.title : "traces",
    traces: candidate.traces,
  };
}

export function embeddedTrace(): { name: string; data: unknown; transcript: string } | null {
  if (window.__TRACE_DATA__ === undefined) return null;
  return {
    name: window.__TRACE_NAME__ ?? "trace",
    data: window.__TRACE_DATA__,
    transcript: window.__TRACE_TEXT__ ?? "",
  };
}

export async function fetchMeta(): Promise<Meta> {
  return getJson("/api/meta");
}

export async function fetchTree(): Promise<TreeNode> {
  return getJson("/api/tree");
}

export async function fetchTrace(selection: TraceSelection): Promise<TracePayload> {
  const params = new URLSearchParams({ path: selection.path });
  if (selection.line !== undefined) params.set("line", String(selection.line));
  return getJson(`/api/trace?${params}`);
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `${url} failed with ${response.status}`);
  }
  return response.json();
}

/** Subscribe to file-change events; returns an unsubscribe function. */
export function subscribeChanges(onChange: (paths: string[]) => void): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "changed") onChange(payload.paths ?? []);
    } catch {
      // malformed event — ignore
    }
  };
  return () => source.close();
}
