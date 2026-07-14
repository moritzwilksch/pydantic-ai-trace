// Hand-written types for the pydantic-ai ModelMessage wire format
// (pydantic_ai_slim/pydantic_ai/messages.py). Everything is optional-friendly:
// dumps from older/newer pydantic-ai versions must never crash the viewer.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  details: Record<string, number>;
}

export interface SystemPromptPart {
  part_kind: "system-prompt";
  content: string;
  timestamp?: string | null;
}

export type UserContentItem =
  | string
  | { kind: "text-content"; text?: string; content?: string; [key: string]: unknown }
  | { kind: "image-url" | "audio-url" | "document-url" | "video-url"; url: string }
  | { kind: "binary"; data: string; media_type: string }
  | { kind: "uploaded-file"; [key: string]: unknown }
  | { kind: "cache-point" }
  | { kind?: string; [key: string]: unknown };

export interface UserPromptPart {
  part_kind: "user-prompt";
  content: string | UserContentItem[];
  timestamp?: string | null;
}

export interface ToolReturnPart {
  part_kind: "tool-return" | "builtin-tool-return";
  tool_name: string;
  content: unknown;
  tool_call_id: string;
  outcome?: "success" | "failed" | "denied" | null;
  metadata?: unknown;
  timestamp?: string | null;
  tool_kind?: string;
}

export interface ErrorDetail {
  type: string;
  loc: (string | number)[];
  msg: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

export interface RetryPromptPart {
  part_kind: "retry-prompt";
  content: string | ErrorDetail[];
  tool_name?: string | null;
  tool_call_id?: string;
  timestamp?: string | null;
}

export interface TextPart {
  part_kind: "text";
  content: string;
  id?: string | null;
}

export interface ThinkingPart {
  part_kind: "thinking";
  content: string;
  id?: string | null;
  signature?: string | null;
  provider_name?: string | null;
}

export interface ToolCallPart {
  part_kind: "tool-call" | "builtin-tool-call";
  tool_name: string;
  /** Raw wire value is string | object | null; parse.ts adds `parsedArgs`. */
  args: string | Record<string, unknown> | null;
  parsedArgs?: unknown;
  tool_call_id: string;
  tool_kind?: string;
}

export interface CompactionPart {
  part_kind: "compaction";
  /** Summary of the compacted history; null when the provider keeps it opaque. */
  content?: string | null;
  id?: string | null;
  provider_name?: string | null;
}

export interface FilePart {
  part_kind: "file";
  content: { data?: string; media_type?: string; [key: string]: unknown };
  id?: string | null;
}

export interface UnknownPart {
  part_kind: string;
  [key: string]: unknown;
}

export type Part =
  | SystemPromptPart
  | UserPromptPart
  | ToolReturnPart
  | RetryPromptPart
  | TextPart
  | ThinkingPart
  | ToolCallPart
  | CompactionPart
  | FilePart
  | UnknownPart;

export interface ModelRequest {
  kind: "request";
  parts: Part[];
  instructions?: string | null;
  run_id?: string | null;
  state?: "complete" | "interrupted";
  [key: string]: unknown;
}

export interface ModelResponse {
  kind: "response";
  parts: Part[];
  usage?: Usage;
  model_name?: string | null;
  timestamp?: string | null;
  provider_name?: string | null;
  provider_response_id?: string | null;
  finish_reason?: "stop" | "length" | "content_filter" | "tool_call" | "error" | null;
  run_id?: string | null;
  state?: "complete" | "interrupted";
  [key: string]: unknown;
}

export interface UnknownMessage {
  kind: "unknown";
  raw: unknown;
}

export type Message = ModelRequest | ModelResponse | UnknownMessage;

// --- API payloads ---

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
