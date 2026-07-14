import { Brain } from "lucide-preact";
import type { ThinkingPart as ThinkingPartType } from "../../types";
import { Block } from "../Block";
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
      badges={part.provider_name ? <span class="badge">{part.provider_name}</span> : null}
      preview={typeof part.content === "string" ? part.content : undefined}
    >
      <div class="thinking">
        <ValueView value={part.content} />
      </div>
    </Block>
  );
}
