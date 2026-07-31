import { FileText, Film, ImageOff, Paperclip, Volume2 } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import {
  byteLength,
  CollapsedPayload,
  formatBytes,
  JsonTree,
  LARGE_PAYLOAD_BYTES,
} from "../JsonTree";
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
    if (mediaType.startsWith("image/")) {
      return <InlineImage mediaType={mediaType} data={item.data} alt="inline image" />;
    }
    return <MediaChip icon={<Paperclip size={13} />} label={`binary · ${mediaType}`} />;
  }
  const url = item.url as string;
  if (kind === "image-url") {
    return <MediaImage src={url} alt="image attachment" chipLabel={url} href={url} />;
  }
  const icon = URL_KIND_ICONS[kind] ?? <Paperclip size={13} />;
  return <MediaChip icon={icon} label={url} href={url} />;
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
  href,
}: {
  src: string;
  alt: string;
  chipLabel: string;
  href?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <MediaChip icon={<ImageOff size={13} />} label={chipLabel} href={href} />;
  }
  return (
    <div class="media-item">
      <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </div>
  );
}

/** Base64 payload rendered as an inline image. */
export function InlineImage({
  mediaType,
  data,
  alt,
}: {
  mediaType: string;
  data: unknown;
  alt: string;
}) {
  return (
    <MediaImage
      src={`data:${mediaType};base64,${data}`}
      alt={alt}
      chipLabel={`image · ${mediaType}`}
    />
  );
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
export function ValueView({ value, markdown = false }: { value: unknown; markdown?: boolean }) {
  if (typeof value === "string") {
    const body = markdown ? <Markdown source={value} /> : <pre class="raw-text">{value}</pre>;
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
