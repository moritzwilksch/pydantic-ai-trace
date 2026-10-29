import { PanelLeft } from "lucide-preact";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Hint } from "./Hint";
import { Button } from "./ui/button";

/** The element the toggle controls: the tree pane, which overlays the trace on narrow screens. */
export const SIDEBAR_ID = "trace-sidebar";

export interface Sidebar {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Open state of the sidebar overlay. CSS shows the toggle and the overlay only on
 * narrow screens; on wide screens the sidebar always sits beside the trace.
 * Opening moves focus into the sidebar; Escape closes it, and closing returns
 * focus to the toggle when focus was in the sidebar.
 */
export function useSidebar(): Sidebar {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (open && !wasOpen.current) {
      sidebar?.querySelector<HTMLElement>("input, button")?.focus();
    } else if (!open && wasOpen.current) {
      const focus = document.activeElement;
      if (focus === null || focus === document.body || sidebar?.contains(focus)) {
        toggleRef.current?.focus();
      }
    }
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return { open, setOpen, toggleRef };
}

/**
 * The sidebar pane. Below 720px it leaves the layout: hidden until the layout carries
 * `sidebar-open` (see `layoutClass` in app.tsx), then an overlay.
 */
export const SIDEBAR_PANE_CLASS =
  "tree-pane flex w-70 shrink-0 flex-col overflow-hidden border-r bg-background " +
  "max-[720px]:fixed max-[720px]:inset-y-0 max-[720px]:left-0 max-[720px]:z-30 " +
  "max-[720px]:hidden max-[720px]:w-[min(280px,85vw)] max-[720px]:shadow-lg " +
  "max-[720px]:[.sidebar-open_&]:flex";

/** Shown on narrow screens only; wide screens always show the sidebar. */
export function SidebarToggle({ sidebar }: { sidebar: Sidebar }) {
  return (
    <Hint label="Show traces">
      <Button
        ref={sidebar.toggleRef}
        variant="ghost"
        size="icon-sm"
        className="hidden shrink-0 max-[720px]:inline-flex"
        aria-label="Show traces"
        aria-controls={SIDEBAR_ID}
        aria-expanded={sidebar.open}
        onClick={() => sidebar.setOpen(!sidebar.open)}
      >
        <PanelLeft />
      </Button>
    </Hint>
  );
}

/** Covers the trace while the overlay is open; a click closes the overlay. */
export function SidebarBackdrop({ sidebar }: { sidebar: Sidebar }) {
  return sidebar.open ? (
    <div
      class="fixed inset-0 z-25 hidden bg-black/30 max-[720px]:block"
      aria-hidden="true"
      onClick={() => sidebar.setOpen(false)}
    />
  ) : null;
}
