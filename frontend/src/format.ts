// Display helpers. Parsing, pairing, and totals happen in Python; these only
// shape already-computed values for the screen.

import { jsonEntries, parseJson } from "./json";

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

/** A cost in USD from its exact decimal string, e.g. `$0.0028`. */
export function formatCost(costUsd: string): string {
  return `$${Number(costUsd).toFixed(4)}`;
}
