import { describe, expect, it } from "vitest";
import fullTraceJson from "../../tests/fixtures/full_trace.json?raw";
import fullTraceText from "../../tests/fixtures/full_trace.txt?raw";
import mediaTraceJson from "../../tests/fixtures/runs/media_and_builtins.json?raw";
import mediaTraceText from "../../tests/fixtures/runs/media_and_builtins.txt?raw";
import edgeTraceJson from "../../tests/fixtures/text_edge_cases.json?raw";
import edgeTraceText from "../../tests/fixtures/text_edge_cases.txt?raw";
import { formatTraceAsText } from "./formatTrace";
import { parseTrace } from "./parse";

describe("formatTraceAsText", () => {
  it.each([
    ["full_trace.json", fullTraceJson, fullTraceText],
    ["media_and_builtins.json", mediaTraceJson, mediaTraceText],
    ["text_edge_cases.json", edgeTraceJson, edgeTraceText],
  ])("matches the shared %s golden output", (name, traceJson, expected) => {
    expect(formatTraceAsText(parseTrace(JSON.parse(traceJson)), name)).toBe(expected);
  });

  it("preserves message and part order without pairing tool calls", () => {
    const messages = parseTrace([
      {
        kind: "request",
        parts: [
          { part_kind: "system-prompt", content: "Be precise." },
          { part_kind: "user-prompt", content: "Find the population." },
        ],
      },
      {
        kind: "response",
        parts: [
          { part_kind: "thinking", content: "I should look it up.", signature: "omit-me" },
          {
            part_kind: "tool-call",
            tool_name: "lookup",
            args: '{"city":"Berlin"}',
            tool_call_id: "call-secret",
          },
        ],
        model_name: "gpt-test",
        provider_name: "openai",
        usage: { input_tokens: 10, output_tokens: 3 },
        finish_reason: "tool_call",
      },
      {
        kind: "request",
        parts: [
          {
            part_kind: "tool-return",
            tool_name: "lookup",
            content: { population: 123 },
            tool_call_id: "call-secret",
          },
        ],
      },
      {
        kind: "response",
        parts: [{ part_kind: "text", content: "The population is **123**." }],
        usage: { input_tokens: 15, output_tokens: 5 },
        timestamp: "2026-01-01T00:00:01Z",
      },
    ]);

    const text = formatTraceAsText(messages, "run.json");

    expect(text).toContain("========== TRACE ==========\n\nNAME: run.json");
    expect(text).toContain("LLM CALLS: 2 | TOKENS: 25 in → 8 out");
    expect(text).toContain("--- SYSTEM PROMPT ---\n\nBe precise.");
    expect(text).toContain("--- USER PROMPT ---\n\nFind the population.");
    expect(text).toContain("========== REQUEST 1 ==========");
    expect(text).toContain("========== RESPONSE 1 · gpt-test · 10 in → 3 out ==========");
    expect(text).toContain("========== REQUEST 2 ==========");
    expect(text).toContain("========== RESPONSE 2 · 15 in → 5 out ==========");
    expect(text).toContain("--- THINKING ---\n\nI should look it up.");
    expect(text).toContain('--- TOOL CALL: lookup ---\n\nARGUMENTS:\n{"city":"Berlin"}');
    expect(text).toContain('--- TOOL RETURN: lookup ---\n\n{"population":123}');
    expect(text).toContain("--- TEXT ---\n\nThe population is **123**.");
    expect(text).not.toContain("call-secret");
    expect(text).not.toContain("omit-me");
    expect(text).not.toContain("openai");
    expect(text).not.toContain("tool_call");

    const callIndex = text.indexOf("--- TOOL CALL: lookup ---");
    const secondRequestIndex = text.indexOf("========== REQUEST 2 ==========", callIndex);
    const returnIndex = text.indexOf("--- TOOL RETURN: lookup ---");
    expect(callIndex).toBeLessThan(secondRequestIndex);
    expect(secondRequestIndex).toBeLessThan(returnIndex);
  });

  it("describes media without copying base64 and preserves unknown data", () => {
    const messages = parseTrace([
      {
        kind: "request",
        parts: [
          {
            part_kind: "user-prompt",
            content: [
              "Inspect these.",
              { kind: "image-url", url: "https://example.com/cat.png" },
              { kind: "binary", media_type: "text/plain", data: "aGVsbG8=" },
            ],
          },
        ],
      },
      {
        kind: "response",
        parts: [{ part_kind: "future-vision", content: "visible", payload: { answer: 42 } }],
      },
    ]);

    const text = formatTraceAsText(messages, "media.json");

    expect(text).toContain("[image] https://example.com/cat.png");
    expect(text).toContain("[binary: text/plain, 5 B, payload omitted]");
    expect(text).not.toContain("aGVsbG8=");
    expect(text).toContain("--- UNKNOWN PART: future-vision ---");
    expect(text).toContain(
      '{"part_kind":"future-vision","content":"visible","payload":{"answer":42}}',
    );
  });

  it("keeps retries and interrupted state in their original messages", () => {
    const messages = parseTrace([
      {
        kind: "response",
        state: "interrupted",
        parts: [
          { part_kind: "tool-call", tool_name: "retry_me", args: null, tool_call_id: "c1" },
          { part_kind: "tool-call", tool_name: "lost", args: {}, tool_call_id: "c2" },
        ],
      },
      {
        kind: "request",
        state: "interrupted",
        parts: [
          {
            part_kind: "retry-prompt",
            tool_name: "retry_me",
            content: "bad arguments",
            tool_call_id: "c1",
          },
          {
            part_kind: "tool-return",
            tool_name: "orphan",
            content: "unexpected",
            tool_call_id: "missing",
          },
        ],
      },
    ]);

    const text = formatTraceAsText(messages, "broken.json");

    expect(text).toContain("========== RESPONSE 1 [INTERRUPTED] ==========");
    expect(text).toContain("========== REQUEST 1 [INTERRUPTED] ==========");
    expect(text).toContain("--- RETRY PROMPT: retry_me ---\n\nbad arguments");
    expect(text).toContain("--- TOOL RETURN: orphan ---\n\nunexpected");
    expect(text).not.toContain("Result:");
    expect(text).not.toContain("unmatched");
  });

  it("includes cached usage in the response envelope", () => {
    const messages = parseTrace([
      {
        kind: "response",
        parts: [],
        model_name: "claude-test",
        usage: { input_tokens: 900, cache_read_tokens: 700, output_tokens: 120 },
      },
    ]);

    expect(formatTraceAsText(messages, "cached.json")).toContain(
      "========== RESPONSE 1 · claude-test · 900 in (700 cached) → 120 out ==========",
    );
  });
});
