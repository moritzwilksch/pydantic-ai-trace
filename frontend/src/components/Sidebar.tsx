import { PanelLeft } from "lucide-preact";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

/** The element the toggle controls: the tree pane, which overlays the trace on narrow screens. */
export const SIDEBAR_ID = "trace-sidebar";

export interface Sidebar {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement>;
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

export function SidebarToggle({ sidebar }: { sidebar: Sidebar }) {
  return (
    <button
      ref={sidebar.toggleRef}
      type="button"
      class="icon-button sidebar-toggle"
      aria-label="Show traces"
      title="Show traces"
      aria-controls={SIDEBAR_ID}
      aria-expanded={sidebar.open}
      onClick={() => sidebar.setOpen(!sidebar.open)}
    >
      <PanelLeft size={14} />
    </button>
  );
}

/** Covers the trace while the overlay is open; a click closes the overlay. */
export function SidebarBackdrop({ sidebar }: { sidebar: Sidebar }) {
  return sidebar.open ? (
    <div class="sidebar-backdrop" aria-hidden="true" onClick={() => sidebar.setOpen(false)} />
  ) : null;
}
