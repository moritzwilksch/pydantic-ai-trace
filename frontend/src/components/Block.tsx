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
  defaultOpen = false,
  children,
}: {
  label: ComponentChildren;
  tone?: Tone;
  badges?: ComponentChildren;
  /** Dimmed one-line teaser shown while collapsed. */
  preview?: string;
  defaultOpen?: boolean;
  children: ComponentChildren;
}) {
  const hasTruncatedPreview =
    preview !== undefined && (preview.length > 96 || preview.endsWith("…"));
  return (
    <details class={`content-block${tone ? ` tone-${tone}` : ""}`} open={defaultOpen}>
      <summary aria-label={hasTruncatedPreview ? "Expand to view the full value" : undefined}>
        <span class="block-label">{label}</span>
        {badges}
        {preview ? (
          <span
            class="block-preview"
            title={hasTruncatedPreview ? "Expand to view the full value" : preview}
          >
            {preview}
          </span>
        ) : null}
        {hasTruncatedPreview ? (
          <span class="preview-more" title="Expand to view the full value">
            more
          </span>
        ) : null}
      </summary>
      <div class="block-body">{children}</div>
    </details>
  );
}
