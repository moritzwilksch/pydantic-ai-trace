import { CircleHelp } from "lucide-preact";
import { compactJson } from "../../parse";
import { Block } from "../Block";
import { JsonTree } from "../JsonTree";

/** Raw-JSON rendering for part kinds this viewer does not know (yet). */
export function FallbackPart({ part }: { part: Record<string, unknown> }) {
  return (
    <Block
      label={
        <>
          <CircleHelp size={13} /> {String(part.part_kind ?? "unknown part")}
        </>
      }
      badges={<span class="badge warn">unknown kind</span>}
      preview={compactJson(part)}
    >
      <JsonTree value={part} />
    </Block>
  );
}
