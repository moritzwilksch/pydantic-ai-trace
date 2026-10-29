import { ListPlus } from "lucide-preact";
import type { ToolAvailabilityDeltaPart } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { JsonTree } from "../JsonTree";
import { CHIPS_CLASS, ToolChip } from "./ToolCallGroup";

/**
 * The set of tools the model can see changed here. pydantic-ai only records
 * additions, so the part is a marker: the names alone say what the following
 * turns are allowed to call.
 */
export function ToolAvailabilityDelta({ part }: { part: ToolAvailabilityDeltaPart }) {
  const added = part.tools_added;
  return (
    <Block
      label={
        <>
          <ListPlus size={13} /> Tools available
        </>
      }
      tone="tool"
      badges={<Badge variant="outline">{added.length} added</Badge>}
      preview={added.map((name) => `+${name}`).join(", ")}
    >
      {added.length > 0 ? (
        <div class={CHIPS_CLASS}>
          {added.map((name) => (
            <ToolChip key={name}>+{name}</ToolChip>
          ))}
        </div>
      ) : (
        <JsonTree value={part} />
      )}
    </Block>
  );
}
