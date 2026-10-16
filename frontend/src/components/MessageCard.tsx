import { ScrollText } from "lucide-preact";
import { cacheHitRate, formatCost } from "../format";
import type { RunEntry, RunIndex, TrajectoryIndex } from "../runIndex";
import type { Message, ModelResponse, Part, RequestUsage } from "../types";
import { Block } from "./Block";
import { ValueView } from "./parts/common";
import { CompactionPart } from "./parts/CompactionPart";
import { FallbackPart } from "./parts/FallbackPart";
import { FilePart } from "./parts/FilePart";
import { RetryPrompt } from "./parts/RetryPrompt";
import { SystemPrompt } from "./parts/SystemPrompt";
import { TextPart } from "./parts/TextPart";
import { ThinkingPart } from "./parts/ThinkingPart";
import { ToolAvailabilityDelta } from "./parts/ToolAvailabilityDelta";
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
  messageIndex,
  run,
  trajectory,
  onOpenRun,
  showInstructions,
  runStartMs,
}: {
  message: Message;
  messageIndex: number;
  run: RunIndex;
  trajectory: TrajectoryIndex;
  onOpenRun: (runId: string) => void;
  showInstructions: boolean;
  runStartMs: number | null;
}) {
  const visibleParts = message.parts
    .map((part, partIndex) => ({ part: part as Part, partIndex }))
    .filter(({ part }) => !isInvisible(part));

  return (
    <div class="card" data-card>
      <div class={`card-kind kind-${message.kind}`}>
        {message.kind === "request" ? "Request" : "Response"}
        {message.state !== "complete" ? <span class="badge warn">{message.state}</span> : null}
        <Timestamp value={message.timestamp ?? null} runStartMs={runStartMs} />
      </div>
      <div class="card-body">
        {message.state === "interrupted" ? <InterruptedMessage kind={message.kind} /> : null}
        {message.kind === "request" && showInstructions && message.instructions ? (
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
              <ValueView value={message.instructions} markdown preserveNewlines />
            </Block>
          </div>
        ) : null}
        {visibleParts.map(({ part, partIndex }) => (
          <div class="part" data-nav key={partIndex}>
            <PartView
              part={part}
              messageIndex={messageIndex}
              partIndex={partIndex}
              run={run}
              trajectory={trajectory}
              onOpenRun={onOpenRun}
            />
          </div>
        ))}
      </div>
      {message.kind === "response" ? (
        <ResponseFooter response={message} costUsd={run.responseCost(messageIndex)} />
      ) : null}
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
  return part.part_kind === "thinking" && !part.content;
}

function PartView({
  part,
  messageIndex,
  partIndex,
  run,
  trajectory,
  onOpenRun,
}: {
  part: Part;
  messageIndex: number;
  partIndex: number;
  run: RunIndex;
  trajectory: TrajectoryIndex;
  onOpenRun: (runId: string) => void;
}) {
  switch (part.part_kind) {
    case "system-prompt":
      return <SystemPrompt part={part} />;
    case "user-prompt":
      return <UserPrompt part={part} />;
    case "text":
      return <TextPart part={part} />;
    case "thinking":
      return <ThinkingPart part={part} />;
    case "tool-call":
    case "builtin-tool-call": {
      const info = run.toolCall(messageIndex, partIndex);
      const childRuns = (info?.child_run_ids ?? [])
        .map((id) => trajectory.entries.get(id))
        .filter((child): child is RunEntry => child !== undefined);
      return (
        <ToolCallGroup
          part={part}
          args={info?.args ?? null}
          result={info?.result ? (run.part(info.result) ?? null) : null}
          childRuns={childRuns}
          onOpenRun={onOpenRun}
        />
      );
    }
    case "retry-prompt":
      return <RetryPrompt part={part} />;
    case "tool-return":
    case "builtin-tool-return":
      return (
        <ToolReturn part={part} hasMatchingCall={run.isMatchedResult(messageIndex, partIndex)} />
      );
    case "compaction":
      return <CompactionPart part={part} />;
    case "file":
      return <FilePart part={part} />;
    case "tool-availability-delta":
      return <ToolAvailabilityDelta part={part} />;
    default:
      return <FallbackPart part={part as unknown as Record<string, unknown>} />;
  }
}

function ResponseFooter({
  response,
  costUsd,
}: {
  response: ModelResponse;
  costUsd: string | null;
}) {
  return (
    <div class="card-footer">
      {response.model_name ? <span>{response.model_name}</span> : null}
      {response.provider_name ? <span>{response.provider_name}</span> : null}
      {response.finish_reason ? <span>finish: {response.finish_reason}</span> : null}
      <UsageSummary usage={response.usage} />
      {costUsd !== null ? <span>{formatCost(costUsd)}</span> : null}
    </div>
  );
}

function UsageSummary({ usage }: { usage: RequestUsage }) {
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

function Timestamp({ value, runStartMs }: { value: string | null; runStartMs: number | null }) {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const offset = runStartMs !== null ? ` (+${((parsed - runStartMs) / 1000).toFixed(1)}s)` : "";
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
