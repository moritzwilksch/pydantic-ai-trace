import { Route } from "lucide-preact";

/** The app's name atop the sidebar, level with the trace header beside it. */
export function Brand() {
  return (
    <div class="flex h-12 shrink-0 items-center gap-2 border-b px-3 text-[13px] font-semibold">
      <Route size={16} aria-hidden="true" class="text-brand" />
      <span>paitrace</span>
    </div>
  );
}
