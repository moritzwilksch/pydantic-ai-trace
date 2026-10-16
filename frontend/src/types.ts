// The Python-to-viewer contract is generated from `pydantic_ai_trace.payload.TracePayload`
// into ./generated/payload.ts. This module adds names the renderers share, plus the
// hand-written shapes of the directory-browsing API.

import type { ModelRequest, ModelResponse } from "./generated/payload";

export type * from "./generated/payload";

export type Message = ModelRequest | ModelResponse;
export type RequestPart = ModelRequest["parts"][number];
export type ResponsePart = ModelResponse["parts"][number];
export type Part = RequestPart | ResponsePart;
export type UserContent = Extract<Part, { part_kind: "user-prompt" }>["content"];
export type UserContentItem = Exclude<UserContent, string>[number];

/** Every part pydantic-ai dumps as `tool-call` or `builtin-tool-call`. */
export type AnyToolCallPart = Extract<Part, { part_kind: "tool-call" | "builtin-tool-call" }>;

/** Every part pydantic-ai dumps as `tool-return` or `builtin-tool-return`. */
export type AnyToolReturnPart = Extract<Part, { part_kind: "tool-return" | "builtin-tool-return" }>;

/** Framework-emitted tool variants, discriminated by `tool_kind`. */
export const TOOL_SEARCH_KIND = "tool-search";
export const CAPABILITY_LOAD_KIND = "capability-load";

// --- directory-browsing API ---

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  format?: "json" | "jsonl";
  trace_count?: number;
  error?: boolean;
  error_message?: string;
  children?: TreeNode[];
}

export interface Meta {
  mode: "file" | "dir";
  root: string;
}

export interface TraceSelection {
  path: string;
  line?: number;
}
