import { ScrollText } from "lucide-preact";
import { cacheHitRate, formatCost, formatCount, formatDuration, formatPercent } from "../format";
import type { RunIndex } from "../runIndex";
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
import {
  OutputAccepted,
  OutputCall,
  pairedCall,
  ToolCallGroup,
  ToolReturn,
} from "./parts/ToolCallGroup";
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
  onOpenRun,
  instructions,
  runStartMs,
}: {
  message: Message;
  messageIndex: number;
  run: RunIndex;
  onOpenRun: (runId: string) => void;
  /** Request instructions to show, or null where they repeat the previous ones. */
  instructions: string | null;
  runStartMs: number;
}) {
  const visibleParts = message.parts
    .map((part, partIndex) => ({ part: part as Part, partIndex }))
    .filter(({ part }) => !isInvisible(part));

  return (
    <div class="card" data-card>
      <div class={`card-kind kind-${message.kind}`}>
        {message.kind === "request" ? "Request" : "Response"}
        {message.state !== "complete" ? <span class="badge warn">{message.state}</span> : null}
        <Timestamp value={message.timestamp} runStartMs={runStartMs} />
      </div>
      <div class="card-body">
        {message.state === "interrupted" ? <InterruptedMessage kind={message.kind} /> : null}
        {instructions !== null ? (
          <div class="part" data-nav>
            <Block
              label={
                <>
                  <ScrollText size={13} /> Instructions
                </>
              }
              tone="system"
              preview={instructions}
            >
              <ValueView value={instructions} markdown preserveNewlines />
            </Block>
          </div>
        ) : null}
        {visibleParts.map(({ part, partIndex }) => (
          <div class="part" data-nav data-part={`${messageIndex}:${partIndex}`} key={partIndex}>
            <PartView
              part={part}
              messageIndex={messageIndex}
              partIndex={partIndex}
              run={run}
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
  onOpenRun,
}: {
  part: Part;
  messageIndex: number;
  partIndex: number;
  run: RunIndex;
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
      const call = run.toolCall(messageIndex, partIndex);
      if (call === undefined)
        return <FallbackPart part={part as unknown as Record<string, unknown>} />;
      const { info, number } = call;
      if (info.is_output) {
        return (
          <OutputCall
            part={part}
            number={number}
            result={info.result}
            args={info.args}
            childRuns={run.childRuns(info)}
            onOpenRun={onOpenRun}
          />
        );
      }
      const resultPart = info.result === null ? null : run.part(info.result);
      return (
        <ToolCallGroup
          part={part}
          number={number}
          args={info.args}
          result={
            info.result !== null && resultPart !== null
              ? { ref: info.result, part: resultPart }
              : null
          }
          childRuns={run.childRuns(info)}
          onOpenRun={onOpenRun}
        />
      );
    }
    case "retry-prompt":
      return <RetryPrompt part={part} call={pairedCall(run, messageIndex, partIndex)} />;
    case "tool-return":
    case "builtin-tool-return": {
      const call = pairedCall(run, messageIndex, partIndex);
      if (call?.isOutput) return <OutputAccepted part={part} call={call} />;
      return <ToolReturn part={part} call={call} />;
    }
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
      ? ` (${formatCount(usage.cache_read_tokens)} cached, ${formatPercent(hitRate)})`
      : "";
  return (
    <span>
      {formatCount(usage.input_tokens)} in{cached} → {formatCount(usage.output_tokens)} out
    </span>
  );
}

function Timestamp({ value, runStartMs }: { value: string | null; runStartMs: number }) {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return (
    <span class="when" title={value}>
      {new Date(parsed).toLocaleTimeString()} (+{formatDuration((parsed - runStartMs) / 1000)})
    </span>
  );
}
