import { SlidersHorizontal } from "lucide-preact";
import type { ModelSettingsDeltaPart } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { CHIPS_CLASS } from "./ToolCallGroup";

/**
 * Model settings in effect from here on, such as the thinking effort. Request-level
 * settings open a new window; others are delivered mid-conversation.
 */
export function ModelSettingsDelta({ part }: { part: ModelSettingsDeltaPart }) {
  const entries = Object.entries(part.settings).map(([key, value]) => `${key}: ${value ?? "none"}`);
  return (
    <Block
      label={
        <>
          <SlidersHorizontal size={13} /> Model settings
        </>
      }
      tone="system"
      badges={part.top_level ? <Badge variant="outline">request-level</Badge> : null}
      preview={entries.join(", ")}
    >
      <div class={CHIPS_CLASS}>
        {entries.map((entry) => (
          <Badge key={entry} variant="secondary" className="font-mono font-normal">
            {entry}
          </Badge>
        ))}
      </div>
    </Block>
  );
}
