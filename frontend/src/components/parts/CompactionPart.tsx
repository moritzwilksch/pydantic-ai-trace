import { Archive } from "lucide-preact";
import { markdownPreview } from "../../format";
import type { CompactionPart as CompactionPartType } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { ValueView } from "./common";

/** The model compacted earlier history into a summary (or an opaque provider blob). */
export function CompactionPart({ part }: { part: CompactionPartType }) {
  return (
    <Block
      label={
        <>
          <Archive size={13} /> Compaction
        </>
      }
      tone="assistant"
      badges={part.provider_name ? <Badge variant="outline">{part.provider_name}</Badge> : null}
      preview={part.content ? markdownPreview(part.content) : "history compacted"}
    >
      {part.content ? (
        <ValueView value={part.content} markdown />
      ) : (
        <div class="italic text-muted-foreground">
          History was compacted by the provider; no readable summary.
        </div>
      )}
    </Block>
  );
}
