import { FileText, Film, ImageIcon, ImageOff, Paperclip, Volume2 } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { JsonTree } from "../JsonTree";
import { Markdown, RAW_TEXT_CLASS } from "../Markdown";
import { Badge } from "../ui/badge";

/** Linked-chip icons for `*-url` attachments; unknown url kinds get a paperclip. */
const URL_KIND_ICONS: Record<string, ComponentChildren> = {
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
    const mediaType =
      typeof item.media_type === "string" ? item.media_type : "application/octet-stream";
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
function linkableUrl(url: string): string | undefined {
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
    <Badge
      variant="outline"
      size="lg"
      className="media-chip max-w-full font-normal text-muted-foreground"
      render={href ? <a href={href} target="_blank" rel="noreferrer noopener" /> : undefined}
    >
      {icon} <span class="truncate">{label}</span>
    </Badge>
  );
  return <div class={MEDIA_ITEM_CLASS}>{body}</div>;
}

/** One attachment or value among a message's content items. */
export const MEDIA_ITEM_CLASS = "my-1.5";

/** An image that degrades to a MediaChip instead of the browser's broken-image icon. */
function MediaImage({
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
    <div class={MEDIA_ITEM_CLASS}>
      <img
        class="max-h-100 max-w-full rounded-md border"
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
      />
      {caption && <div class="text-xs text-muted-foreground">{caption}</div>}
    </div>
  );
}

/** A dumped `BinaryContent` image, captioned with its identifier. */
function InlineImage({ mediaType, data, name }: { mediaType: string; data: string; name: string }) {
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
function base64DataUrl(mediaType: string, data: string): string {
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
            <div class={MEDIA_ITEM_CLASS} key={i}>
              <ValueView value={item} />
            </div>
          ),
        )}
      </div>
    );
  }
  return <ValueView value={content} />;
}

/** A block body already scrolls; a nested clamp would add a second scrollbar. */
const CLAMP_CLASS = "max-h-80 overflow-y-auto in-[.block-body]:max-h-none";

/**
 * Markdown for strings, JsonTree for anything else. Every rendering is clamped
 * to the display max height (scrolls internally).
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
    return (
      <div class={CLAMP_CLASS}>
        {markdown ? (
          <Markdown source={value} preserveNewlines={preserveNewlines} />
        ) : (
          <pre class={RAW_TEXT_CLASS}>{value}</pre>
        )}
      </div>
    );
  }
  return (
    <div class={CLAMP_CLASS}>
      <JsonTree value={value} />
    </div>
  );
}
