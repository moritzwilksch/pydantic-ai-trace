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
import { Hint } from "./Hint";
import { Button } from "./ui/button";

/** The element the toggle controls: the tree pane, which overlays the trace on narrow screens. */
export const SIDEBAR_ID = "trace-sidebar";

const WIDTH_KEY = "paitrace-sidebar-width";

export interface Sidebar {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  /** Width beside the trace on wide screens, in pixels; remembered across visits. */
  width: number;
  /** Clamps; `persist: false` skips storage, for the moves of a drag. */
  setWidth: (width: number, persist?: boolean) => void;
}

/**
 * Open state of the sidebar overlay. CSS shows the toggle and the overlay only on
 * narrow screens; on wide screens the sidebar always sits beside the trace.
 * Opening moves focus into the sidebar; Escape closes it, and closing returns
 * focus to the toggle when focus was in the sidebar. The width, clamped and
 * stored, applies beside the trace and caps the overlay.
 */
export function useSidebar(): Sidebar {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const [width, setStoredWidth] = useState(() =>
    parseSidebarWidth(storage((s) => s.getItem(WIDTH_KEY))),
  );
  const setWidth = (next: number, persist = true) => {
    const clamped = clampSidebarWidth(next);
    setStoredWidth(clamped);
    if (persist) storage((s) => s.setItem(WIDTH_KEY, String(clamped)));
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
 * The sidebar's right edge on wide screens: a grab strip centered on the pane's
 * border, taking no layout width. Drag it, or focus it and press the arrow keys, to
 * resize the sidebar; double-click it to restore the default width.
 */
export function SidebarResizer({ sidebar }: { sidebar: Sidebar }) {
  // Where the drag started; pointer capture keeps the moves coming off the handle.
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      class="relative z-20 -mr-1 -ml-0.75 w-1.75 shrink-0 cursor-col-resize touch-none outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 hover:before:bg-ring focus-visible:before:bg-ring max-[720px]:hidden"
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
        if (start) sidebar.setWidth(start.width + event.clientX - start.x, false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        sidebar.setWidth(sidebar.width); // store where the drag ended
      }}
      onDblClick={() => sidebar.setWidth(SIDEBAR_WIDTH.default)}
      onKeyDown={(event) => {
        const next = keyedSidebarWidth(sidebar.width, event.key, event.shiftKey);
        if (next === null) return;
        // The keys are the handle's own; the trace's arrow-key navigation must not see them.
        event.preventDefault();
        event.stopPropagation();
        sidebar.setWidth(next);
      }}
    />
  );
}

/**
 * The sidebar pane. Below 720px it leaves the layout: hidden until the layout carries
 * `sidebar-open` (see `layoutClass` in app.tsx), then an overlay.
 */
export const SIDEBAR_PANE_CLASS =
  "tree-pane flex w-(--sidebar-width) shrink-0 flex-col overflow-hidden border-r bg-background " +
  "max-[720px]:fixed max-[720px]:inset-y-0 max-[720px]:left-0 max-[720px]:z-30 " +
  "max-[720px]:hidden max-[720px]:w-[min(var(--sidebar-width),85vw)] max-[720px]:shadow-lg " +
  "max-[720px]:[.sidebar-open_&]:flex";

/** Shown on narrow screens only; wide screens always show the sidebar. */
export function SidebarToggle({ sidebar }: { sidebar: Sidebar }) {
  return (
    <Hint label="Show traces">
      <Button
        ref={sidebar.toggleRef}
        variant="ghost"
        size="icon-sm"
        className="hidden max-[720px]:inline-flex"
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
