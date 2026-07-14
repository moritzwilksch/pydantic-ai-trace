import { Settings } from "lucide-preact";
import type { SystemPromptPart } from "../../types";
import { Block } from "../Block";
import { ValueView } from "./common";

export function SystemPrompt({ part }: { part: SystemPromptPart }) {
  return (
    <Block
      label={
        <>
          <Settings size={13} /> System prompt
        </>
      }
      tone="system"
      preview={part.content}
    >
      <ValueView value={part.content} markdown />
    </Block>
  );
}
