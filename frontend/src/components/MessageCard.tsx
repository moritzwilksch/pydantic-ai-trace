import { cacheHitRate } from "../parse";
import type { Pairing } from "../pairing";
import { ScrollText } from "lucide-preact";
import type {
  CompactionPart as CompactionPartType,
  FilePart as FilePartType,
  Message,
  ModelResponse,
  Part,
  RetryPromptPart,
  SystemPromptPart,
  TextPart as TextPartType,
  ThinkingPart as ThinkingPartType,
  ToolCallPart,
  ToolReturnPart,
  Usage,
  UserPromptPart,
} from "../types";
import { Block } from "./Block";
import { JsonTree } from "./JsonTree";
import { ValueView } from "./parts/common";
import { CompactionPart } from "./parts/CompactionPart";
import { FallbackPart } from "./parts/FallbackPart";
import { FilePart } from "./parts/FilePart";
import { RetryPrompt } from "./parts/RetryPrompt";
import { SystemPrompt } from "./parts/SystemPrompt";
import { TextPart } from "./parts/TextPart";
import { ThinkingPart } from "./parts/ThinkingPart";
import { ToolCallGroup, ToolReturn } from "./parts/ToolCallGroup";
import { UserPrompt } from "./parts/UserPrompt";

/**
 * One card = one ModelMessage, mirroring pydantic-ai's types: a "Request" or
 * "Response" header with each part as a uniform labeled block underneath.
 * Tool pairing annotates calls with their outcome, but every message and part
 * renders in its original JSON position so the card sequence stays faithful.
 */
export function MessageCard({
  message,
  pairing,
  traceStartMs,
}: {
  message: Message;
  pairing: Pairing;
  traceStartMs: number | null;
}) {
  if (message.kind === "unknown") {
    return (
      <div class="card" data-card>
        <div class="card-kind">unknown message</div>
        <div class="card-body">
          <div class="part" data-nav>
            <JsonTree value={message.raw} />
          </div>
        </div>
      </div>
    );
  }

  const visibleParts = message.parts.filter((part) => !isInvisible(part));

  return (
    <div class="card" data-card>
      <div class={`card-kind kind-${message.kind}`}>
        {message.kind === "request" ? "Request" : "Response"}
        {message.state === "interrupted" ? <span class="badge warn">interrupted</span> : null}
        <Timestamp
          value={typeof message.timestamp === "string" ? message.timestamp : null}
          traceStartMs={traceStartMs}
        />
      </div>
      <div class="card-body">
        {message.state === "interrupted" ? <InterruptedMessage kind={message.kind} /> : null}
        {message.kind === "request" && message.instructions ? (
          <div class="part" data-nav>
            <Block
              label={
                <>
                  <ScrollText size={13} /> Instructions
                </>
              }
              tone="system"
              preview={message.instructions}
            >
              <ValueView value={message.instructions} markdown />
            </Block>
          </div>
        ) : null}
        {visibleParts.map((part, i) => (
          <div class="part" data-nav key={i}>
            <PartView part={part} pairing={pairing} />
          </div>
        ))}
      </div>
      {message.kind === "response" ? <ResponseFooter response={message} /> : null}
    </div>
  );
}

function InterruptedMessage({ kind }: { kind: "request" | "response" }) {
  const subject = kind === "request" ? "before a response was recorded" : "before it completed";
  return (
    <div class="interrupted-message" role="note">
      This {kind} was interrupted {subject}. The trace does not include a reason.
    </div>
  );
}

/**
 * Parts that render nothing must not become (invisible) keyboard-navigation
 * targets: signature-only thinking is the one part kind we deliberately hide.
 */
function isInvisible(part: Part): boolean {
  return part.part_kind === "thinking" && !(part as ThinkingPartType).content;
}

function PartView({ part, pairing }: { part: Part; pairing: Pairing }) {
  // Casts are safe: part_kind is the wire discriminator, and every renderer
  // tolerates missing fields (dumps from other pydantic-ai versions).
  switch (part.part_kind) {
    case "system-prompt":
      return <SystemPrompt part={part as SystemPromptPart} />;
    case "user-prompt":
      return <UserPrompt part={part as UserPromptPart} />;
    case "text":
      return <TextPart part={part as TextPartType} />;
    case "thinking":
      return <ThinkingPart part={part as ThinkingPartType} />;
    case "tool-call":
    case "builtin-tool-call": {
      const result = pairing.resultsByCall.get(part) ?? null;
      return <ToolCallGroup part={part as ToolCallPart} result={result} />;
    }
    case "retry-prompt":
      return <RetryPrompt part={part as RetryPromptPart} />;
    case "tool-return":
    case "builtin-tool-return":
      return (
        <ToolReturn
          part={part as ToolReturnPart}
          hasMatchingCall={pairing.matchedResults.has(part)}
        />
      );
    case "compaction":
      return <CompactionPart part={part as CompactionPartType} />;
    case "file":
      return <FilePart part={part as FilePartType} />;
    default:
      return <FallbackPart part={part as Record<string, unknown>} />;
  }
}

function ResponseFooter({ response }: { response: ModelResponse }) {
  const usage = response.usage;
  return (
    <div class="card-footer">
      {response.model_name ? <span>{response.model_name}</span> : null}
      {response.provider_name ? <span>{response.provider_name}</span> : null}
      {response.finish_reason ? <span>finish: {response.finish_reason}</span> : null}
      {usage ? <UsageSummary usage={usage} /> : null}
    </div>
  );
}

function UsageSummary({ usage }: { usage: Usage }) {
  const hitRate = cacheHitRate(usage.input_tokens, usage.cache_read_tokens);
  const cached =
    hitRate !== null
      ? ` (${formatCount(usage.cache_read_tokens)} cached, ${hitRate.toFixed(1)}%)`
      : "";
  return (
    <span>
      {formatCount(usage.input_tokens)} in{cached} → {formatCount(usage.output_tokens)} out
    </span>
  );
}

function Timestamp({ value, traceStartMs }: { value: string | null; traceStartMs: number | null }) {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const offset = traceStartMs !== null ? ` (+${((parsed - traceStartMs) / 1000).toFixed(1)}s)` : "";
  return (
    <span class="when" title={value}>
      {new Date(parsed).toLocaleTimeString()}
      {offset}
    </span>
  );
}

export function formatCount(count: number): string {
  if (count < 10_000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}
