import { PackagePlus } from "lucide-preact";
import type { CapabilityLoadDeltaPart } from "../../types";
import { Block } from "../Block";
import { Badge } from "../ui/badge";
import { CHIPS_CLASS, ToolChip } from "./ToolCallGroup";

/**
 * On-demand capabilities loaded here, from code rather than a `load_capability` call.
 * Their tools and instructions apply from the next request.
 */
export function CapabilityLoadDelta({ part }: { part: CapabilityLoadDeltaPart }) {
  const loaded = part.loaded;
  return (
    <Block
      label={
        <>
          <PackagePlus size={13} /> Capabilities loaded
        </>
      }
      tone="tool"
      badges={<Badge variant="outline">{loaded.length} loaded</Badge>}
      preview={loaded.map((id) => `+${id}`).join(", ")}
    >
      <div class={CHIPS_CLASS}>
        {loaded.map((id) => (
          <ToolChip key={id}>+{id}</ToolChip>
        ))}
      </div>
    </Block>
  );
}
