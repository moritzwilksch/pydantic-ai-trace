import { ChevronRight } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { cn } from "../lib/utils";

/** Identity color of a block label — who/what produced this content. */
export type Tone = "user" | "system" | "assistant" | "tool" | "error";

const TONE_TEXT: Record<Tone, string> = {
  user: "text-user",
  system: "text-system",
  assistant: "text-assistant",
  tool: "text-tool",
  error: "text-destructive-foreground",
};

/**
 * Collapsible content block — the uniform building unit of a message card.
 * Every part renders as one of these so requests and responses share the same
 * visual grammar. The body is clamped to a max display height and scrolls
 * internally, so even expanded blocks never dominate the page.
 *
 * Blocks stay native <details>: keyboard navigation and search open and close
 * them in place through the DOM.
 */
export function Block({
  label,
  tone,
  badges,
  preview,
  trailing,
  defaultOpen = false,
  children,
}: {
  label: ComponentChildren;
  tone?: Tone;
  badges?: ComponentChildren;
  /** Dimmed one-line teaser shown while collapsed. */
  preview?: string;
  /** Shown at the right edge of the header. */
  trailing?: ComponentChildren;
  defaultOpen?: boolean;
  children: ComponentChildren;
}) {
  return (
    <details class={blockClass(tone)} open={defaultOpen}>
      <BlockSummary label={label} tone={tone}>
        {badges}
        <BlockPreview text={preview} />
        {trailing}
      </BlockSummary>
      <div class="block-body max-h-80 overflow-y-auto border-t px-2.5 py-2">{children}</div>
    </details>
  );
}

/** Classes of a block's <details>; `extra` names a block kind for tests and styles. */
export function blockClass(tone: Tone | undefined, extra?: string): string {
  return cn(
    "content-block group/block rounded-lg border bg-muted/50",
    tone && `tone-${tone}`,
    tone === "error" && "border-destructive/32 bg-destructive/4",
    extra,
  );
}

/** A block's header row: a disclosure chevron, the tone-colored label, then `children`. */
export function BlockSummary({
  label,
  tone,
  children,
}: {
  label: ComponentChildren;
  tone: Tone | undefined;
  children?: ComponentChildren;
}) {
  return (
    <summary class="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs select-none [&::-webkit-details-marker]:hidden">
      <ChevronRight
        size={14}
        aria-hidden="true"
        class="shrink-0 text-muted-foreground transition-transform group-open/block:rotate-90"
      />
      <span
        class={cn(
          "block-label inline-flex items-center gap-1.25 font-semibold whitespace-nowrap",
          tone ? TONE_TEXT[tone] : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      {children}
    </summary>
  );
}

const EXPAND_HINT = "Expand to view the full value";

/**
 * The collapsed teaser of a content block's summary, with a "more" hint when
 * the text is likely cut off. Both hide while the block is open.
 */
export function BlockPreview({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <>
      <span
        // After a tool's `name(args) →`, long arguments must not squeeze the result to nothing.
        class="block-preview min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground [.pair-arrow+&]:min-w-[min(14ch,25%)]"
        title={isCutOff(text) ? EXPAND_HINT : text}
      >
        {text}
      </span>
      <MoreHint text={text} />
    </>
  );
}

/**
 * "more" after a header teaser that is likely cut off; hidden while the block
 * is open. For headers whose teaser is not a `BlockPreview`, such as a tool
 * call's signature.
 */
export function MoreHint({ text }: { text: string }) {
  if (!isCutOff(text)) return null;
  return (
    <span
      class="preview-more shrink-0 text-[10px] font-medium text-muted-foreground"
      title={EXPAND_HINT}
      data-search-ignore
    >
      more
    </span>
  );
}

function isCutOff(text: string): boolean {
  return text.length > 96 || text.endsWith("…");
}
