import type { ComponentChildren } from "preact";

/** Identity color of a block label — who/what produced this content. */
export type Tone = "user" | "system" | "assistant" | "tool" | "error";

/**
 * Collapsible content block — the uniform building unit of a message card.
 * Every part renders as one of these so requests and responses share the same
 * visual grammar. The body is clamped to a max display height and scrolls
 * internally, so even expanded blocks never dominate the page.
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
    <details class={`content-block${tone ? ` tone-${tone}` : ""}`} open={defaultOpen}>
      <summary>
        <span class="block-label">{label}</span>
        {badges}
        <BlockPreview text={preview} />
        {trailing}
      </summary>
      <div class="block-body">{children}</div>
    </details>
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
      <span class="block-preview" title={isCutOff(text) ? EXPAND_HINT : text}>
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
    <span class="preview-more" title={EXPAND_HINT}>
      more
    </span>
  );
}

function isCutOff(text: string): boolean {
  return text.length > 96 || text.endsWith("…");
}
