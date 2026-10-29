import { FileText } from "lucide-preact";
import type { FilePart as FilePartType } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { MediaContent } from "./common";

export function FilePart({ part }: { part: FilePartType }) {
  return (
    <Block
      label={
        <>
          <FileText size={13} /> File
        </>
      }
      tone="assistant"
      badges={<Badge variant="outline">{part.content.media_type}</Badge>}
    >
      <MediaContent item={part.content as unknown as Record<string, unknown>} />
    </Block>
  );
}
