import type { VNode } from "preact";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * A tooltip naming the control `children` renders, shown on hover and keyboard focus.
 * For the few controls in the header; dense trace content keeps native titles.
 */
export function Hint({ label, children }: { label: string; children: VNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
