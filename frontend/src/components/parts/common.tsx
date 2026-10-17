import { FileText, Film, ImageIcon, ImageOff, Paperclip, Volume2 } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { byteLength, CollapsedPayload, JsonTree, LARGE_PAYLOAD_BYTES } from "../JsonTree";
import { formatBytes } from "../../format";
import { Markdown } from "../Markdown";

/** Linked-chip icons for `*-url` attachments; unknown url kinds get a paperclip. */
export const URL_KIND_ICONS: Record<string, ComponentChildren> = {
  "audio-url": <Volume2 size={13} />,
  "video-url": <Film size={13} />,
  "document-url": <FileText size={13} />,
};

/** True for objects shaped like pydantic-ai MultiModalContent (BinaryContent or a `*-url`). */
// Deliberately not a type predicate: narrowing would collapse UserContentItem
// unions to `never` in the else branch at call sites.
export function isMediaItem(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.kind !== "string") return false;
  if (item.kind === "binary") return typeof item.data === "string";
  return item.kind.endsWith("-url") && typeof item.url === "string";
}

/** Render one MultiModalContent item: inline images, chips for everything else. */
export function MediaContent({ item }: { item: Record<string, unknown> }) {
  const kind = String(item.kind);
  if (kind === "binary") {
    const mediaType = String(item.media_type ?? "application/octet-stream");
    // Pydantic AI defaults the identifier to a short hash of the data, so it is
    // always present in a dump; the model refers to the file by it.
    const name = typeof item.identifier === "string" ? item.identifier : "binary";
    if (mediaType.startsWith("image/")) {
      return <InlineImage mediaType={mediaType} data={String(item.data)} name={name} />;
    }
    return <MediaChip icon={<Paperclip size={13} />} label={`${name} · ${mediaType}`} />;
  }
  const url = item.url as string;
  if (kind === "image-url") {
    // Loading a remote image would tell its server that someone opened this trace.
    if (!url.startsWith("data:")) {
      return <MediaChip icon={<ImageIcon size={13} />} label={url} href={linkableUrl(url)} />;
    }
    return <MediaImage src={url} alt="image attachment" chipLabel="image attachment" />;
  }
  const icon = URL_KIND_ICONS[kind] ?? <Paperclip size={13} />;
  return <MediaChip icon={icon} label={url} href={linkableUrl(url)} />;
}

/** `url` when it is safe to link (http or https); trace URLs are untrusted, e.g. `javascript:`. */
export function linkableUrl(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined; // relative or malformed: nothing to link to
  }
}

/** Pill-shaped chip for non-inline attachments; linked when `href` is given. */
export function MediaChip({
  icon,
  label,
  href,
}: {
  icon: ComponentChildren;
  label: string;
  href?: string;
}) {
  const body = (
    <span class="media-chip">
      {icon} {label}
    </span>
  );
  return (
    <div class="media-item">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {body}
        </a>
      ) : (
        body
      )}
    </div>
  );
}

/** An image that degrades to a MediaChip instead of the browser's broken-image icon. */
export function MediaImage({
  src,
  alt,
  chipLabel,
  caption,
}: {
  src: string;
  alt: string;
  chipLabel: string;
  caption?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaChip icon={<ImageOff size={13} />} label={chipLabel} />;
  return (
    <div class="media-item">
      <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      {caption && <div class="media-caption">{caption}</div>}
    </div>
  );
}

/** A dumped `BinaryContent` image, captioned with its identifier. */
export function InlineImage({
  mediaType,
  data,
  name,
}: {
  mediaType: string;
  data: string;
  name: string;
}) {
  return (
    <MediaImage
      src={base64DataUrl(mediaType, data)}
      alt={name}
      chipLabel={`${name} · ${mediaType}`}
      caption={name}
    />
  );
}

/**
 * A `data:` URL for bytes from the payload. Pydantic serializes bytes as URL-safe
 * base64 (`-`, `_`); `data:` URLs need the standard alphabet (`+`, `/`).
 */
export function base64DataUrl(mediaType: string, data: string): string {
  const standard = data.replaceAll("-", "+").replaceAll("_", "/");
  return `data:${mediaType};base64,${standard}`;
}

/**
 * A tool return value: media items (tools returning images/files) render
 * inline instead of dumping base64 into the JSON tree; plain values fall
 * through to ValueView.
 */
export function ToolReturnValue({ content }: { content: unknown }) {
  if (isMediaItem(content)) return <MediaContent item={content as Record<string, unknown>} />;
  if (Array.isArray(content) && content.some(isMediaItem)) {
    return (
      <div>
        {content.map((item, i) =>
          isMediaItem(item) ? (
            <MediaContent key={i} item={item as Record<string, unknown>} />
          ) : (
            <div class="media-item" key={i}>
              <ValueView value={item} />
            </div>
          ),
        )}
      </div>
    );
  }
  return <ValueView value={content} />;
}

/**
 * Markdown for strings, JsonTree for anything else. Every rendering is clamped
 * to the display max height (scrolls internally); very large strings render
 * collapsed so the DOM stays small.
 */
export function ValueView({
  value,
  markdown = false,
  preserveNewlines = false,
}: {
  value: unknown;
  markdown?: boolean;
  preserveNewlines?: boolean;
}) {
  if (typeof value === "string") {
    const body = markdown ? (
      <Markdown source={value} preserveNewlines={preserveNewlines} />
    ) : (
      <pre class="raw-text">{value}</pre>
    );
    const size = byteLength(value);
    if (size > LARGE_PAYLOAD_BYTES) {
      return <CollapsedPayload sizeLabel={formatBytes(size)}>{body}</CollapsedPayload>;
    }
    return <div class="clamp">{body}</div>;
  }
  return (
    <div class="clamp">
      <JsonTree value={value} />
    </div>
  );
}
