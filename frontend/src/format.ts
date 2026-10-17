// Display helpers. Parsing, pairing, and totals happen in Python; these only
// shape already-computed values for the screen.

import { jsonEntries, parseJson } from "./json";
import type { Totals } from "./types";

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
 * One-line plain-text preview of markdown, e.g. `**Done.** See [docs](…)` → `Done. See docs`.
 * Strips common syntax with a few regexes over a bounded prefix instead of
 * parsing, so every collapsed block can afford it.
 */
export function markdownPreview(source: string, maxLength = 200): string {
  const prefix = source.slice(0, maxLength * 2);
  const text = prefix
    .replace(/^\s{0,3}(```|~~~).*$/gm, "") // code fences
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "") // block markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/\*\*/g, "") // bold cut off by the prefix bound
    .replace(/(?<!\w)([*_])(?=\S)(.+?)(?<=\S)\1(?!\w)/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const truncated = text.length > maxLength || prefix.length < source.length;
  return truncated ? `${text.slice(0, maxLength - 1)}…` : text;
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

/** A token or call count: exact with digit grouping below 10,000, else abbreviated (`20.46M`). */
export function formatCount(count: number): string {
  if (count < 10_000) return count.toLocaleString("en-US");
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Tenths of a second below a minute (`6.0s`), else whole units (`14m 23s`, `2h 5m 0s`). */
export function formatDuration(seconds: number): string {
  if (Math.round(seconds * 10) < 600) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${secs}s` : `${minutes}m ${secs}s`;
}

/** A percentage to one decimal, e.g. `42.5%`. */
export function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

/** A cost in USD from its exact decimal string, e.g. `$0.0028`. */
export function formatCost(costUsd: string): string {
  return `$${Number(costUsd).toFixed(4)}`;
}

/**
 * The cost of a total, marked partial when some responses had no known price, so
 * unknown prices never read as free. Null when there is nothing to show.
 */
export function formatTotalsCost(totals: Totals): string | null {
  if (totals.cost_usd === null) return totals.unpriced_calls > 0 ? "cost unknown" : null;
  const cost = formatCost(totals.cost_usd);
  return totals.unpriced_calls > 0 ? `${cost} (+${totals.unpriced_calls} unpriced)` : cost;
}
