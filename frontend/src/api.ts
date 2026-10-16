// Data access: REST endpoints, SSE change feed, and the exported-HTML
// fallback where the payload is embedded as window.__TRACE_PAYLOAD__.

import { parseJson } from "./json";
import type { Meta, TracePayload, TraceSelection, TreeNode } from "./types";

declare global {
  interface Window {
    __TRACE_PAYLOAD__?: string;
  }
}

/** The payload `paitrace export` embedded in this document, if any. */
export function embeddedPayload(): TracePayload | null {
  if (window.__TRACE_PAYLOAD__ === undefined) return null;
  try {
    return parseJson(window.__TRACE_PAYLOAD__) as TracePayload;
  } catch {
    return null;
  }
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
  const url = `/api/trace?${params}`;
  const response = await fetch(url);
  if (!response.ok) await throwFetchError(url, response);
  // Trace values keep their source key order, which JSON.parse would not.
  return parseJson(await response.text()) as TracePayload;
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) await throwFetchError(url, response);
  return response.json();
}

async function throwFetchError(url: string, response: Response): Promise<never> {
  const detail = await response.json().catch(() => null);
  throw new Error(detail?.error ?? `${url} failed with ${response.status}`);
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
