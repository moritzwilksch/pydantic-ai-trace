import { computeStats } from "./parse";
import type {
  CompactionPart,
  FilePart,
  Message,
  ModelResponse,
  Part,
  RetryPromptPart,
  ToolCallPart,
  ToolReturnPart,
  UserContentItem,
  UserPromptPart,
} from "./types";

/**
 * Render the trace in the same message/part order as the viewer.
 *
 * Message envelopes use strong separators, parts use lighter separators, and
 * response-only metadata lives in the response envelope. Identifiers,
 * timestamps, signatures, and binary payloads are deliberately omitted.
 */
export function formatTraceAsText(messages: Message[], name: string): string {
  const sections = [section(envelope("TRACE"), traceDetails(messages, name))];
  let requestNumber = 0;
  let responseNumber = 0;
  let lastInstructions: string | null = null;

  for (const message of messages) {
    if (message.kind === "unknown") {
      sections.push(section(envelope("UNKNOWN MESSAGE"), json(message.raw)));
      continue;
    }

    const parts: string[] = [];
    if (
      message.kind === "request" &&
      message.instructions &&
      message.instructions !== lastInstructions
    ) {
      parts.push(partSection("INSTRUCTIONS", message.instructions));
      lastInstructions = message.instructions;
    }
    for (const part of message.parts) {
      const formatted = formatPart(part);
      if (formatted) parts.push(formatted);
    }

    let heading: string;
    if (message.kind === "response") {
      responseNumber += 1;
      heading = responseEnvelope(message, responseNumber);
    } else {
      requestNumber += 1;
      heading = requestEnvelope(message.state, requestNumber);
    }
    sections.push(section(heading, parts.join("\n\n")));
  }

  return `${sections.join("\n\n")}\n`;
}

function traceDetails(messages: Message[], name: string): string {
  const stats = computeStats(messages);
  const tokens = tokenUsage(stats.inputTokens, stats.outputTokens, stats.cacheReadTokens);
  const summary = [`LLM CALLS: ${stats.requestCount}`, `TOKENS: ${tokens}`];
  if (stats.wallTimeMs !== null) summary.push(`WALL TIME: ${formatSeconds(stats.wallTimeMs)}`);
  return `NAME: ${inline(name)}\n${summary.join(" | ")}`;
}

function requestEnvelope(state: "complete" | "interrupted" | undefined, number: number): string {
  return envelope(
    state === "interrupted" ? `REQUEST ${number} [INTERRUPTED]` : `REQUEST ${number}`,
  );
}

function responseEnvelope(response: ModelResponse, number: number): string {
  const details = [
    response.state === "interrupted" ? `RESPONSE ${number} [INTERRUPTED]` : `RESPONSE ${number}`,
  ];
  if (response.model_name) details.push(inline(response.model_name));
  if (response.usage) {
    details.push(
      tokenUsage(
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.usage.cache_read_tokens,
      ),
    );
  }
  return envelope(details.join(" · "));
}

function tokenUsage(input: number, output: number, cached: number): string {
  const cache = cached > 0 ? ` (${cached} cached)` : "";
  return `${input} in${cache} → ${output} out`;
}

function formatPart(part: Part): string {
  switch (part.part_kind) {
    case "system-prompt":
      return partSection("SYSTEM PROMPT", String(part.content ?? ""));
    case "user-prompt":
      return partSection("USER PROMPT", formatUserContent((part as UserPromptPart).content));
    case "text":
      return partSection("TEXT", String(part.content ?? ""));
    case "thinking":
      return part.content ? partSection("THINKING", String(part.content)) : "";
    case "tool-call":
    case "builtin-tool-call":
      return formatToolCall(part as ToolCallPart);
    case "tool-return":
    case "builtin-tool-return":
      return formatToolReturn(part as ToolReturnPart);
    case "retry-prompt":
      return formatRetryPrompt(part as RetryPromptPart);
    case "compaction": {
      const content = (part as CompactionPart).content;
      return partSection(
        "COMPACTION",
        content || "[History compacted by the provider; no readable summary.]",
      );
    }
    case "file":
      return partSection("FILE", formatFile(part as FilePart));
    default:
      return partSection(`UNKNOWN PART: ${inline(part.part_kind)}`, json(part));
  }
}

function formatToolCall(part: ToolCallPart): string {
  const kind = part.part_kind === "builtin-tool-call" ? "BUILTIN TOOL CALL" : "TOOL CALL";
  const toolKind = part.tool_kind ? ` [${inline(part.tool_kind).toUpperCase()}]` : "";
  const args = part.parsedArgs !== undefined ? part.parsedArgs : part.args;
  return partSection(
    `${kind}: ${inline(part.tool_name)}${toolKind}`,
    `ARGUMENTS:\n${formatValue(args)}`,
  );
}

function formatToolReturn(part: ToolReturnPart): string {
  const kind = part.part_kind === "builtin-tool-return" ? "BUILTIN TOOL RETURN" : "TOOL RETURN";
  const outcome =
    part.outcome === "failed" || part.outcome === "denied"
      ? ` [${part.outcome.toUpperCase()}]`
      : "";
  return partSection(`${kind}: ${inline(part.tool_name)}${outcome}`, formatValue(part.content));
}

function formatRetryPrompt(part: RetryPromptPart): string {
  const tool = part.tool_name ? `: ${inline(part.tool_name)}` : "";
  return partSection(`RETRY PROMPT${tool}`, formatValue(part.content));
}

function formatUserContent(content: UserPromptPart["content"]): string {
  const items = Array.isArray(content) ? content : [content];
  return items.map(formatUserItem).join("\n\n");
}

function formatUserItem(item: UserContentItem): string {
  if (typeof item === "string") return item;
  if (item.kind === "text") return typeof item.text === "string" ? item.text : json(item);
  if (item.kind === "text-content") {
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
    return json(item);
  }
  if (item.kind === "uploaded-file") return "[uploaded file]";
  if (item.kind === "cache-point") return "[cache point]";
  if (isMedia(item)) return formatMedia(item);
  return json(item);
}

function formatFile(part: FilePart): string {
  return isMedia(part.content) ? formatMedia(part.content) : json(part.content);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (isMedia(value)) return formatMedia(value);
  if (Array.isArray(value) && value.some(isMedia)) {
    return value
      .map((item) => (isMedia(item) ? formatMedia(item) : formatValue(item)))
      .join("\n\n");
  }
  return json(value);
}

function isMedia(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind === "binary") return typeof item.data === "string";
  return (
    typeof item.kind === "string" && item.kind.endsWith("-url") && typeof item.url === "string"
  );
}

function formatMedia(item: Record<string, unknown>): string {
  const kind = String(item.kind);
  if (kind === "binary") {
    const mediaType = String(item.media_type ?? "application/octet-stream");
    const bytes = base64ByteLength(String(item.data ?? ""));
    return `[binary: ${mediaType}, ${formatBytes(bytes)}, payload omitted]`;
  }
  return `[${kind.replace(/-url$/, "")}] ${String(item.url)}`;
}

function base64ByteLength(data: string): number {
  const normalized = data.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function json(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function envelope(label: string): string {
  return `========== ${label} ==========`;
}

function partSection(label: string, body: string): string {
  return section(`--- ${label} ---`, body);
}

function section(heading: string, body: string): string {
  return body ? `${heading}\n\n${body}` : heading;
}

function inline(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}
