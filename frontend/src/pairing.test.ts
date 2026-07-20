import { describe, expect, it } from "vitest";
import { parseTrace } from "./parse";
import { pairToolCalls } from "./pairing";
import type { ModelRequest, ModelResponse } from "./types";

function trace(messages: unknown[]) {
  return parseTrace(messages);
}

describe("pairToolCalls", () => {
  it("pairs a call with its return in a later request", () => {
    const messages = trace([
      {
        kind: "response",
        parts: [{ part_kind: "tool-call", tool_name: "t", args: null, tool_call_id: "c1" }],
      },
      {
        kind: "request",
        parts: [{ part_kind: "tool-return", tool_name: "t", content: "ok", tool_call_id: "c1" }],
      },
    ]);
    const pairing = pairToolCalls(messages);
    const call = (messages[0] as ModelResponse).parts[0];
    expect(pairing.resultsByCall.get(call)).toMatchObject({ kind: "return" });
    const returnPart = (messages[1] as ModelRequest).parts[0];
    expect(pairing.matchedResults.has(returnPart)).toBe(true);
  });

  it("pairs a call with a retry-prompt answer", () => {
    const messages = trace([
      {
        kind: "response",
        parts: [{ part_kind: "tool-call", tool_name: "t", args: null, tool_call_id: "c1" }],
      },
      {
        kind: "request",
        parts: [
          { part_kind: "retry-prompt", content: "bad args", tool_call_id: "c1", tool_name: "t" },
        ],
      },
    ]);
    const pairing = pairToolCalls(messages);
    expect(pairing.resultsByCall.get((messages[0] as ModelResponse).parts[0])).toMatchObject({
      kind: "retry",
    });
  });

  it("pairs builtin call and return within the same response", () => {
    const messages = trace([
      {
        kind: "response",
        parts: [
          { part_kind: "builtin-tool-call", tool_name: "search", args: {}, tool_call_id: "b1" },
          {
            part_kind: "builtin-tool-return",
            tool_name: "search",
            content: [],
            tool_call_id: "b1",
          },
        ],
      },
    ]);
    const pairing = pairToolCalls(messages);
    expect(pairing.resultsByCall.get((messages[0] as ModelResponse).parts[0])).toMatchObject({
      kind: "return",
    });
    expect(pairing.matchedResults.has((messages[0] as ModelResponse).parts[1])).toBe(true);
  });

  it("leaves orphaned calls unpaired", () => {
    const pairing = pairToolCalls(
      trace([
        {
          kind: "response",
          parts: [{ part_kind: "tool-call", tool_name: "t", args: null, tool_call_id: "lost" }],
        },
      ]),
    );
    expect(pairing.resultsByCall.size).toBe(0);
  });

  it("does not mark returns whose call is missing as matched", () => {
    const messages = trace([
      {
        kind: "request",
        parts: [
          { part_kind: "tool-return", tool_name: "t", content: "ok", tool_call_id: "no-call" },
        ],
      },
    ]);
    const pairing = pairToolCalls(messages);
    expect(pairing.matchedResults.size).toBe(0);
  });

  it("pairs only the first result after a call", () => {
    const messages = trace([
      {
        kind: "response",
        parts: [{ part_kind: "tool-call", tool_name: "t", args: null, tool_call_id: "c1" }],
      },
      {
        kind: "request",
        parts: [
          { part_kind: "tool-return", tool_name: "t", content: "first", tool_call_id: "c1" },
          { part_kind: "tool-return", tool_name: "t", content: "second", tool_call_id: "c1" },
        ],
      },
    ]);
    const pairing = pairToolCalls(messages);
    expect(pairing.matchedResults.size).toBe(1);
    const call = (messages[0] as ModelResponse).parts[0];
    expect((pairing.resultsByCall.get(call)?.part as { content: string }).content).toBe("first");
  });

  it("does not pair a result that precedes its call", () => {
    const messages = trace([
      {
        kind: "request",
        parts: [{ part_kind: "tool-return", tool_name: "t", content: "early", tool_call_id: "c1" }],
      },
      {
        kind: "response",
        parts: [{ part_kind: "tool-call", tool_name: "t", args: null, tool_call_id: "c1" }],
      },
    ]);

    const pairing = pairToolCalls(messages);

    expect(pairing.resultsByCall.size).toBe(0);
    expect(pairing.matchedResults.size).toBe(0);
  });
});
