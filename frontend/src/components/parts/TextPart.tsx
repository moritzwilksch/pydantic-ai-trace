import { MessageSquare } from "lucide-preact";
import { compactJson, parseJsonContainer } from "../../parse";
import type { TextPart as TextPartType } from "../../types";
import { Block } from "../Block";
import { ValueView } from "./common";

export function TextPart({ part }: { part: TextPartType }) {
  const json = parseJsonContainer(part.content);
  return (
    <Block
      label={
        <>
          <MessageSquare size={13} /> Text
        </>
      }
      tone="assistant"
      preview={json === null ? part.content : compactJson(json)}
    >
      <ValueView value={json ?? part.content} markdown={json === null} />
    </Block>
  );
}
