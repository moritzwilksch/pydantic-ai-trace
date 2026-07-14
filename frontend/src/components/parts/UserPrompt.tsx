import { Bookmark, Paperclip, User } from "lucide-preact";
import { compactJson } from "../../parse";
import type { UserContentItem, UserPromptPart } from "../../types";
import { Block } from "../Block";
import { JsonTree } from "../JsonTree";
import { isMediaItem, MediaChip, MediaContent, ValueView } from "./common";

export function UserPrompt({ part }: { part: UserPromptPart }) {
  return (
    <Block
      label={
        <>
          <User size={13} /> User prompt
        </>
      }
      tone="user"
      preview={typeof part.content === "string" ? part.content : compactJson(part.content)}
    >
      {typeof part.content === "string" ? (
        <ValueView value={part.content} markdown />
      ) : (
        <div>
          {part.content.map((item, i) => (
            <ContentItem key={i} item={item} />
          ))}
        </div>
      )}
    </Block>
  );
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
    case "text-content":
      return (
        <div class="media-item">
          <ValueView value={String(item.text ?? item.content ?? "")} markdown />
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
