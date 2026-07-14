import { Archive } from "lucide-preact";
import type { CompactionPart as CompactionPartType } from "../../types";
import { Block } from "../Block";
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
      badges={part.provider_name ? <span class="badge">{part.provider_name}</span> : null}
      preview={part.content ?? "history compacted"}
    >
      {part.content ? (
        <ValueView value={part.content} markdown />
      ) : (
        <div class="thinking">History was compacted by the provider; no readable summary.</div>
      )}
    </Block>
  );
}
