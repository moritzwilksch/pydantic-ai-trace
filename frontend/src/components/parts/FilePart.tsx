import { FileText } from "lucide-preact";
import type { FilePart as FilePartType } from "../../types";
import { Block } from "../Block";
import { JsonTree } from "../JsonTree";
import { isMediaItem, MediaContent } from "./common";

export function FilePart({ part }: { part: FilePartType }) {
  const content = part.content ?? {};
  const mediaType = typeof content.media_type === "string" ? content.media_type : "";
  return (
    <Block
      label={
        <>
          <FileText size={13} /> File
        </>
      }
      tone="assistant"
      badges={mediaType ? <span class="badge">{mediaType}</span> : null}
    >
      {isMediaItem(content) ? <MediaContent item={content} /> : <JsonTree value={content} />}
    </Block>
  );
}
