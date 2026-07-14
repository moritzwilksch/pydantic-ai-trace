import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  compactJson,
  computeStats,
  normalizeUsage,
  parseArgs,
  parseTrace,
} from "./parse";
import type { ModelResponse, ToolCallPart } from "./types";

describe("parseTrace", () => {
  it("keeps request and response messages with their parts", () => {
    const messages = parseTrace([
      { kind: "request", parts: [{ part_kind: "user-prompt", content: "hi" }] },
      { kind: "response", parts: [{ part_kind: "text", content: "hello" }] },
    ]);
    expect(messages.map((m) => m.kind)).toEqual(["request", "response"]);
  });

  it("wraps unknown message kinds instead of dropping them", () => {
    const messages = parseTrace([{ kind: "telepathy", parts: [] }, "not even an object"]);
    expect(messages.every((m) => m.kind === "unknown")).toBe(true);
  });

  it("returns empty list for non-array input", () => {
    expect(parseTrace({ not: "a trace" })).toEqual([]);
    expect(parseTrace(null)).toEqual([]);
  });

  it("parses string tool-call args into parsedArgs", () => {
    const messages = parseTrace([
      {
        kind: "response",
        parts: [{ part_kind: "tool-call", tool_name: "t", args: '{"x": 1}', tool_call_id: "c1" }],
      },
    ]);
    const part = (messages[0] as ModelResponse).parts[0] as ToolCallPart;
    expect(part.parsedArgs).toEqual({ x: 1 });
  });

  it("maps legacy vendor_id to provider_response_id", () => {
    const messages = parseTrace([{ kind: "response", parts: [], vendor_id: "v1" }]);
    expect((messages[0] as ModelResponse).provider_response_id).toBe("v1");
  });
});

describe("parseArgs", () => {
  it("passes objects through", () => {
    expect(parseArgs({ a: 1 })).toEqual({ a: 1 });
  });

  it("keeps unparseable strings as-is", () => {
    expect(parseArgs("not json {")).toBe("not json {");
  });

  it("treats null and undefined as null", () => {
    expect(parseArgs(null)).toBeNull();
    expect(parseArgs(undefined)).toBeNull();
  });
});

describe("normalizeUsage", () => {
  it("accepts current field names", () => {
    const usage = normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 3 });
    expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 3 });
  });

  it("accepts legacy request/response token names", () => {
    const usage = normalizeUsage({ request_tokens: 7, response_tokens: 2 });
    expect(usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
  });

  it("prefers current names when both are present", () => {
    const usage = normalizeUsage({ input_tokens: 1, request_tokens: 99 });
    expect(usage?.input_tokens).toBe(1);
  });
});

describe("compactJson", () => {
  it("renders objects as key: value pairs", () => {
    expect(compactJson({ path: "src/app.py", limit: 5 })).toBe('path: "src/app.py", limit: 5');
  });

  it("renders nested arrays and null", () => {
    expect(compactJson({ ids: [1, 2], next: null })).toBe("ids: [1, 2], next: null");
  });

  it("truncates long output with an ellipsis", () => {
    const long = compactJson({ text: "x".repeat(500) }, 40);
    expect(long.length).toBe(40);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("cacheHitRate", () => {
  it("is null when nothing was cached", () => {
    expect(cacheHitRate(1000, 0)).toBeNull();
  });

  it("uses input tokens as denominator when cache reads are included (OpenAI style)", () => {
    expect(cacheHitRate(1000, 823)).toBeCloseTo(82.3);
  });

  it("adds exclusive cache reads to the denominator (Anthropic style)", () => {
    expect(cacheHitRate(100, 900)).toBeCloseTo(90.0);
  });
});

describe("computeStats", () => {
  it("aggregates tokens, calls, and wall time", () => {
    const messages = parseTrace([
      {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: "q", timestamp: "2026-01-01T00:00:00Z" }],
      },
      {
        kind: "response",
        parts: [],
        usage: { input_tokens: 100, output_tokens: 20 },
        timestamp: "2026-01-01T00:00:10Z",
      },
      {
        kind: "response",
        parts: [],
        usage: { request_tokens: 50, response_tokens: 5 },
        timestamp: "2026-01-01T00:00:30Z",
      },
    ]);
    expect(computeStats(messages)).toMatchObject({
      requestCount: 2,
      inputTokens: 150,
      outputTokens: 25,
      wallTimeMs: 30_000,
    });
  });

  it("reports null wall time without enough timestamps", () => {
    const messages = parseTrace([{ kind: "request", parts: [] }]);
    expect(computeStats(messages).wallTimeMs).toBeNull();
  });
});
