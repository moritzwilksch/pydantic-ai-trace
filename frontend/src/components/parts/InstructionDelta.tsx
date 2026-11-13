import { FileDiff } from "lucide-preact";
import { markdownPreview } from "../../format";
import type { InstructionDeltaPart } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { ValueView } from "./common";

/**
 * An append-mode instruction block's new text from here on, or its withdrawal. The
 * request's instructions keep the text the window started with, so this is the current value.
 */
export function InstructionDelta({ part }: { part: InstructionDeltaPart }) {
  const { content } = part;
  return (
    <Block
      label={
        <>
          <FileDiff size={13} /> Instruction delta
        </>
      }
      tone="system"
      badges={
        <>
          <span class="font-mono text-xs font-semibold">{instructionId(part.id)}</span>
          {content === null ? <Badge variant="outline">withdrawn</Badge> : null}
        </>
      }
      preview={content === null ? undefined : markdownPreview(content)}
    >
      {content === null ? (
        <p class="text-xs text-muted-foreground">The block no longer applies.</p>
      ) : (
        <ValueView value={content} markdown preserveNewlines />
      )}
    </Block>
  );
}

/** A block's id; Pydantic AI leaves it unset for a block nothing addresses. */
function instructionId(id: string | null): string {
  return id ?? "unnamed";
}
