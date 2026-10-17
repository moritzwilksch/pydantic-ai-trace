import { Route } from "lucide-preact";

/** The app's name atop the sidebar, level with the trace header beside it. */
export function Brand() {
  return (
    <div class="brand">
      <Route size={16} aria-hidden="true" />
      <span>paitrace</span>
    </div>
  );
}
