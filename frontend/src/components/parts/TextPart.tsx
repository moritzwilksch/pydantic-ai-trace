import { MessageSquare } from "lucide-preact";
import type { TextPart as TextPartType } from "../../types";
import { Block } from "../Block";
import { ValueView } from "./common";

export function TextPart({ part }: { part: TextPartType }) {
  return (
    <Block
      label={
        <>
          <MessageSquare size={13} /> Text
        </>
      }
      tone="assistant"
      preview={part.content}
    >
      <ValueView value={part.content} markdown />
    </Block>
  );
}
