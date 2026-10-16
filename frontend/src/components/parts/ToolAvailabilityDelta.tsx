import { ListPlus } from "lucide-preact";
import type { ToolAvailabilityDeltaPart } from "../../types";
import { Block } from "../Block";
import { JsonTree } from "../JsonTree";

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
      badges={<span class="badge">{added.length} added</span>}
      preview={added.map((name) => `+${name}`).join(", ")}
    >
      {added.length > 0 ? (
        <div class="tool-chips">
          {added.map((name) => (
            <span class="tool-chip" key={name}>
              +{name}
            </span>
          ))}
        </div>
      ) : (
        <JsonTree value={part} />
      )}
    </Block>
  );
}
