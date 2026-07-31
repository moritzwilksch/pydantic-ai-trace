// Normalization of raw trace JSON into the shapes the components render.
// Tolerant by design: unknown kinds pass through for FallbackPart, legacy
// field names are mapped to their current equivalents, and nothing throws.

import type { Message, ModelResponse, Part, ToolCallPart, Usage } from "./types";
import { jsonEntries, parseJson } from "./json";

export function parseTrace(raw: unknown): Message[] {
  if (typeof raw === "string") {
    try {
      raw = parseJson(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(parseMessage);
}

function parseMessage(raw: unknown): Message {
  if (!isRecord(raw) || !Array.isArray(raw.parts)) return { kind: "unknown", raw };
  const parts = raw.parts.map(parsePart);
  if (raw.kind === "request") return { ...raw, kind: "request", parts };
  if (raw.kind === "response") {
    const response: ModelResponse = { ...raw, kind: "response", parts };
    // Legacy aliases from older pydantic-ai dumps.
    if (raw.usage !== undefined) response.usage = normalizeUsage(raw.usage);
    if (raw.vendor_id !== undefined && raw.provider_response_id === undefined) {
      response.provider_response_id = raw.vendor_id as string;
    }
    return response;
  }
  return { kind: "unknown", raw };
}

function parsePart(raw: unknown): Part {
  if (!isRecord(raw) || typeof raw.part_kind !== "string") {
    return { part_kind: "unknown", raw };
  }
  const part = raw as unknown as Part;
  if (part.part_kind === "tool-call" || part.part_kind === "builtin-tool-call") {
    return { ...part, parsedArgs: parseArgs((part as ToolCallPart).args) };
  }
  return part;
}

/** `ToolCallPart.args` is `string | object | null` on the wire — JSON strings are parsed. */
export function parseArgs(args: string | Record<string, unknown> | null | undefined): unknown {
  if (args == null) return null;
  if (typeof args !== "string") return args;
  try {
    return parseJson(args);
  } catch {
    return args;
  }
}

/** Parse text that consists entirely of a JSON object or array. */
export function parseJsonContainer(content: string): Record<string, unknown> | unknown[] | null {
  try {
    const value = parseJson(content);
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown> | unknown[];
    }
  } catch {
    // Plain text and text containing only a JSON fragment keep their normal renderer.
  }
  return null;
}

export function normalizeUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    input_tokens: firstNumber(raw.input_tokens, raw.request_tokens),
    output_tokens: firstNumber(raw.output_tokens, raw.response_tokens),
    cache_read_tokens: firstNumber(raw.cache_read_tokens),
    cache_write_tokens: firstNumber(raw.cache_write_tokens),
    details: isRecord(raw.details) ? (raw.details as Record<string, number>) : {},
  };
}

/** One-line human preview of a JSON value, e.g. `path: "src/app.py", limit: 5`. */
export function compactJson(value: unknown, maxLength = 120): string {
  const text = compact(value, maxLength + 1);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Serialize at most `limit` characters — stops descending once over budget. */
function compact(value: unknown, limit: number): string {
  const pieces: string[] = [];
  let length = 0;
  const push = (text: string): boolean => {
    pieces.push(text);
    length += text.length;
    return length < limit;
  };
  const walk = (v: unknown): boolean => {
    if (typeof v === "string")
      return push(JSON.stringify(v.length > limit ? v.slice(0, limit) : v));
    if (v === null || typeof v !== "object") return push(String(v));
    const isArray = Array.isArray(v);
    if (isArray && !push("[")) return false;
    let first = true;
    for (const [key, child] of isArray ? v.entries() : jsonEntries(v)) {
      if (!first && !push(", ")) return false;
      first = false;
      if (!isArray && !push(`${key}: `)) return false;
      if (!walk(child)) return false;
    }
    return isArray ? push("]") : true;
  };
  walk(value);
  return pieces.join("").slice(0, limit);
}

/**
 * Cache hit rate in percent, or null when nothing was cached.
 *
 * Providers disagree on whether `input_tokens` includes cache reads (OpenAI:
 * yes, Anthropic: no); when the cache reads don't fit inside `input_tokens`,
 * they must be exclusive, so add them to the denominator.
 */
export function cacheHitRate(inputTokens: number, cacheReadTokens: number): number | null {
  if (cacheReadTokens <= 0) return null;
  const denominator = cacheReadTokens <= inputTokens ? inputTokens : inputTokens + cacheReadTokens;
  return (cacheReadTokens / denominator) * 100;
}

export interface TraceStats {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Milliseconds between first and last message timestamp, if both exist. */
  wallTimeMs: number | null;
}

export function computeStats(messages: Message[]): TraceStats {
  const responses = messages.filter((m): m is ModelResponse => m.kind === "response");
  const timestamps = timestampsMs(messages);
  return {
    requestCount: responses.length,
    inputTokens: sum(responses.map((r) => r.usage?.input_tokens ?? 0)),
    outputTokens: sum(responses.map((r) => r.usage?.output_tokens ?? 0)),
    cacheReadTokens: sum(responses.map((r) => r.usage?.cache_read_tokens ?? 0)),
    wallTimeMs: timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : null,
  };
}

/** All parseable message/part timestamps as epoch millis. */
export function timestampsMs(messages: Message[]): number[] {
  return messages
    .flatMap(collectTimestamps)
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
}

function collectTimestamps(message: Message): string[] {
  if (message.kind === "unknown") return [];
  const own = typeof message.timestamp === "string" ? [message.timestamp] : [];
  const fromParts = message.parts
    .map((p) => (p as { timestamp?: unknown }).timestamp)
    .filter((t): t is string => typeof t === "string");
  return [...own, ...fromParts];
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function firstNumber(...candidates: unknown[]): number {
  for (const c of candidates) if (typeof c === "number") return c;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
