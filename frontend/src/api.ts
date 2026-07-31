// Data access: REST endpoints, SSE change feed, and the exported-HTML
// fallback where the trace is embedded as window.__TRACE_DATA__.

import type { Meta, TraceSelection, TreeNode } from "./types";

declare global {
  interface Window {
    __TRACE_DATA__?: unknown;
    __TRACE_NAME__?: string;
  }
}

export function embeddedTrace(): { name: string; data: unknown } | null {
  if (window.__TRACE_DATA__ === undefined) return null;
  return { name: window.__TRACE_NAME__ ?? "trace", data: window.__TRACE_DATA__ };
}

export async function fetchMeta(): Promise<Meta> {
  return getJson("/api/meta");
}

export async function fetchTree(): Promise<TreeNode> {
  return getJson("/api/tree");
}

export async function fetchTrace(selection: TraceSelection): Promise<unknown> {
  const params = new URLSearchParams({ path: selection.path });
  if (selection.line !== undefined) params.set("line", String(selection.line));
  const url = `/api/trace?${params}`;
  const response = await fetch(url);
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `${url} failed with ${response.status}`);
  }
  return response.text();
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
