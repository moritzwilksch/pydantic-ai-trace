import { Bookmark, Paperclip, User } from "lucide-preact";
import { compactJson } from "../../parse";
import type { UserContentItem, UserPromptPart } from "../../types";
import { Block } from "../Block";
import { JsonTree } from "../JsonTree";
import { isMediaItem, MediaChip, MediaContent, ValueView } from "./common";

export function UserPrompt({ part }: { part: UserPromptPart }) {
  const items = userContentItems(part.content);
  return (
    <Block
      label={
        <>
          <User size={13} /> User prompt
        </>
      }
      tone="user"
      preview={userContentPreview(items)}
    >
      <div>
        {items.map((item, i) => (
          <ContentItem key={i} item={item} />
        ))}
      </div>
    </Block>
  );
}

/** Normalize both valid Pydantic AI wire shapes through one rendering path. */
function userContentItems(content: UserPromptPart["content"]): UserContentItem[] {
  return Array.isArray(content) ? content : [content];
}

/** A scalar string and an equivalent one-item sequence get the same preview. */
function userContentPreview(items: UserContentItem[]): string {
  if (items.length === 1) {
    const text = userContentText(items[0]);
    if (text !== null) return text;
  }
  return compactJson(items);
}

function userContentText(item: UserContentItem): string | null {
  if (typeof item === "string") return item;
  if (item.kind === "text") return typeof item.text === "string" ? item.text : null;
  if (item.kind === "text-content") {
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
    return null;
  }
  return null;
}

function ContentItem({ item }: { item: UserContentItem }) {
  if (typeof item === "string") {
    return (
      <div class="media-item">
        <ValueView value={item} markdown />
      </div>
    );
  }
  // All multi-modal kinds (binary and `*-url`, including url kinds pydantic-ai
  // adds later) share the media renderer and degrade to chips gracefully.
  if (isMediaItem(item)) {
    return <MediaContent item={item as Record<string, unknown>} />;
  }
  switch (item.kind) {
    case "text":
    case "text-content":
      return (
        <div class="media-item">
          <ValueView value={userContentText(item) ?? ""} markdown />
        </div>
      );
    case "uploaded-file":
      return <MediaChip icon={<Paperclip size={13} />} label="uploaded file" />;
    case "cache-point":
      return <MediaChip icon={<Bookmark size={13} />} label="cache point" />;
    default:
      return (
        <div class="media-item">
          <JsonTree value={item} />
        </div>
      );
  }
}
