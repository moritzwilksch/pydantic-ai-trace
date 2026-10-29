import { Brain } from "lucide-preact";
import type { ThinkingPart as ThinkingPartType } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { ValueView } from "./common";

export function ThinkingPart({ part }: { part: ThinkingPartType }) {
  if (!part.content) return null; // signature-only thinking (content not recorded)
  return (
    <Block
      label={
        <>
          <Brain size={13} /> Thinking
        </>
      }
      badges={part.provider_name ? <Badge variant="outline">{part.provider_name}</Badge> : null}
      preview={typeof part.content === "string" ? part.content : undefined}
    >
      <div class="italic text-muted-foreground">
        <ValueView value={part.content} />
      </div>
    </Block>
  );
}
