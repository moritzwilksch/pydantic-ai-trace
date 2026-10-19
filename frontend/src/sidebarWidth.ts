// The sidebar's width on wide screens: bounds, keyboard steps, and the stored value.
// The DOM side, dragging and storage access, lives in `components/Sidebar.tsx`.

export const SIDEBAR_WIDTH = { min: 180, default: 280, max: 640 } as const;

/** Arrow keys move the edge by this many pixels; Shift moves it further. */
export const SIDEBAR_STEP = 16;
export const SIDEBAR_STEP_LARGE = 64;

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

/** A stored width, clamped to the current bounds; the default for anything else. */
export function parseSidebarWidth(stored: string | null): number {
  // Number("") is 0, which would clamp to the minimum instead of the default.
  const width = stored?.trim() ? Number(stored) : NaN;
  return Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_WIDTH.default;
}

/** The width a key on the resize handle asks for, or null for keys it ignores. */
export function keyedSidebarWidth(width: number, key: string, large: boolean): number | null {
  const step = large ? SIDEBAR_STEP_LARGE : SIDEBAR_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(width - step);
    case "ArrowRight":
      return clampSidebarWidth(width + step);
    case "Home":
      return SIDEBAR_WIDTH.min;
    case "End":
      return SIDEBAR_WIDTH.max;
    default:
      return null;
  }
}
