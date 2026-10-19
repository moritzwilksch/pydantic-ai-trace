import { PanelLeft } from "lucide-preact";
import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  clampSidebarWidth,
  keyedSidebarWidth,
  parseSidebarWidth,
  SIDEBAR_WIDTH,
} from "../sidebarWidth";
import { storage } from "../storage";

/** The element the toggle controls: the tree pane, which overlays the trace on narrow screens. */
export const SIDEBAR_ID = "trace-sidebar";

const WIDTH_KEY = "paitrace-sidebar-width";

export interface Sidebar {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement>;
  /** Width beside the trace on wide screens, in pixels; remembered across visits. */
  width: number;
  setWidth: (width: number) => void;
}

/**
 * Open state of the sidebar overlay. CSS shows the toggle and the overlay only on
 * narrow screens; on wide screens the sidebar always sits beside the trace.
 * Opening moves focus into the sidebar; Escape closes it, and closing returns
 * focus to the toggle when focus was in the sidebar. The width, clamped and
 * stored on every change, applies beside the trace and caps the overlay.
 */
export function useSidebar(): Sidebar {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const [width, setStoredWidth] = useState(() =>
    parseSidebarWidth(storage((s) => s.getItem(WIDTH_KEY))),
  );
  const setWidth = (next: number) => {
    const clamped = clampSidebarWidth(next);
    setStoredWidth(clamped);
    storage((s) => s.setItem(WIDTH_KEY, String(clamped)));
  };

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

  return { open, setOpen, toggleRef, width, setWidth };
}

/** Sets the sidebar's width through `--sidebar-width`, which the tree pane reads. */
export function sidebarStyle(sidebar: Sidebar): Record<string, string> {
  return { "--sidebar-width": `${sidebar.width}px` };
}

/**
 * The sidebar's right edge on wide screens. Drag it, or focus it and press the
 * arrow keys, to resize the sidebar; double-click it to restore the default width.
 */
export function SidebarResizer({ sidebar }: { sidebar: Sidebar }) {
  // Where the drag started; pointer capture keeps the moves coming off the handle.
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      class="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-controls={SIDEBAR_ID}
      aria-valuenow={sidebar.width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault(); // no text selection while dragging
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: sidebar.width };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start) sidebar.setWidth(start.width + event.clientX - start.x);
      }}
      onLostPointerCapture={() => (drag.current = null)}
      onDblClick={() => sidebar.setWidth(SIDEBAR_WIDTH.default)}
      onKeyDown={(event) => {
        const next = keyedSidebarWidth(sidebar.width, event.key, event.shiftKey);
        if (next === null) return;
        event.preventDefault();
        sidebar.setWidth(next);
      }}
    />
  );
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
