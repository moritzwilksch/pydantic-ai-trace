// Tool call ↔ result pairing. A ToolCallPart in a response is answered by a
// ToolReturnPart or RetryPromptPart with the same tool_call_id in a later
// request (builtin returns can sit in the same response). Pairing annotates
// calls with their outcome while every result remains in its original position.

import type { Message, Part, RetryPromptPart, ToolReturnPart } from "./types";

export interface ToolResult {
  kind: "return" | "retry";
  part: ToolReturnPart | RetryPromptPart;
}

export interface Pairing {
  /** Tool call part → its next chronological result. */
  resultsByCall: Map<Part, ToolResult>;
  /** Results that have a matching earlier call in the trace. */
  matchedResults: Set<Part>;
}

export function pairToolCalls(messages: Message[]): Pairing {
  const pendingCalls = new Map<string, Part[]>();
  const resultsByCall = new Map<Part, ToolResult>();
  const matchedResults = new Set<Part>();
  for (const message of messages) {
    if (message.kind === "unknown") continue;
    for (const part of message.parts) {
      if (part.part_kind === "tool-call" || part.part_kind === "builtin-tool-call") {
        const callId = (part as { tool_call_id?: unknown }).tool_call_id;
        if (typeof callId === "string") {
          const calls = pendingCalls.get(callId) ?? [];
          calls.push(part);
          pendingCalls.set(callId, calls);
        }
        continue;
      }

      const result = asResult(part);
      const callId = (part as { tool_call_id?: unknown }).tool_call_id;
      if (!result || typeof callId !== "string") continue;
      const calls = pendingCalls.get(callId);
      const call = calls?.shift();
      if (!call) continue;
      resultsByCall.set(call, result);
      matchedResults.add(part);
    }
  }
  return { resultsByCall, matchedResults };
}

function asResult(part: Part): ToolResult | null {
  if (part.part_kind === "tool-return" || part.part_kind === "builtin-tool-return") {
    return { kind: "return", part: part as ToolReturnPart };
  }
  if (part.part_kind === "retry-prompt") {
    return { kind: "retry", part: part as RetryPromptPart };
  }
  return null;
}
