import { ScrollText } from "lucide-preact";
import type { ComponentChildren } from "preact";
import {
  cacheHitRate,
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  markdownPreview,
} from "../format";
import { cn } from "../lib/utils";
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
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Card, CardFooter, CardHeader, CardPanel } from "./ui/card";

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
  const isResponse = message.kind === "response";
  const visibleParts = message.parts
    .map((part, partIndex) => ({ part: part as Part, partIndex }))
    .filter(({ part }) => !isInvisible(part));

  return (
    <Card
      data-card
      className={cn(
        // Offscreen cards skip rendering work; long traces hold hundreds.
        COLUMN_CLASS,
        "[contain-intrinsic-size:auto_120px] [content-visibility:auto]",
        // A faint wash of the "Response" heading's color, so requests and responses
        // tell apart while skimming.
        isResponse && "border-assistant/20 bg-[color-mix(in_srgb,var(--assistant)_4%,var(--card))]",
      )}
    >
      <CardHeader
        className={cn(
          `card-kind kind-${message.kind} flex items-center gap-2 border-b px-3.5 py-2 text-xs font-semibold text-muted-foreground in-[[data-slot=card]:has(>[data-slot=card-panel])]:pb-2`,
          isResponse && "border-assistant/20 text-assistant",
        )}
      >
        {isResponse ? "Response" : "Request"}
        {message.state !== "complete" ? <Badge variant="warning">{message.state}</Badge> : null}
        <Timestamp value={message.timestamp} runStartMs={runStartMs} />
      </CardHeader>
      <CardPanel className="px-3.5 py-2.5">
        {message.state === "interrupted" ? <InterruptedMessage kind={message.kind} /> : null}
        {instructions !== null ? (
          <div class={PART_CLASS} data-nav>
            <Block
              label={
                <>
                  <ScrollText size={13} /> Instructions
                </>
              }
              tone="system"
              preview={markdownPreview(instructions)}
            >
              <ValueView value={instructions} markdown preserveNewlines />
            </Block>
          </div>
        ) : null}
        {visibleParts.map(({ part, partIndex }) => (
          <div
            class={PART_CLASS}
            data-nav
            data-part={`${messageIndex}:${partIndex}`}
            key={partIndex}
          >
            <PartView
              part={part}
              messageIndex={messageIndex}
              partIndex={partIndex}
              run={run}
              onOpenRun={onOpenRun}
            />
          </div>
        ))}
      </CardPanel>
      {message.kind === "response" ? (
        <ResponseFooter response={message} costUsd={run.responseCost(messageIndex)} />
      ) : null}
    </Card>
  );
}

/** Parts are self-delimiting blocks; spacing alone separates them. */
const PART_CLASS = "part [.part+&]:mt-2";

/** Cards, alerts, and notes share one column, wide for data-dense traces. */
export const COLUMN_CLASS = "mx-auto mb-3 max-w-275";

/** A muted remark about the message or run, not part of its content. */
export function Note({ className, children }: { className?: string; children: ComponentChildren }) {
  return (
    <Alert variant="warning" className={cn("note py-2 text-xs", className)} role="note">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function InterruptedMessage({ kind }: { kind: "request" | "response" }) {
  const subject = kind === "request" ? "before a response was recorded" : "before it completed";
  return (
    <Note className="mb-2">
      This {kind} was interrupted {subject}. The trace does not include a reason.
    </Note>
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
    <CardFooter className="card-footer flex-wrap gap-2.5 border-t border-assistant/20 px-3.5 py-1.5 text-[11.5px] text-muted-foreground in-[[data-slot=card]:has(>[data-slot=card-panel])]:pt-1.5">
      {response.model_name ? <span>{response.model_name}</span> : null}
      {response.provider_name ? <span>{response.provider_name}</span> : null}
      {response.finish_reason ? <span>finish: {response.finish_reason}</span> : null}
      <UsageSummary usage={response.usage} />
      {costUsd !== null ? <span>{formatCost(costUsd)}</span> : null}
    </CardFooter>
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
    <span class="ml-auto font-normal text-muted-foreground" title={value}>
      {new Date(parsed).toLocaleTimeString()} (+{formatDuration((parsed - runStartMs) / 1000)})
    </span>
  );
}
