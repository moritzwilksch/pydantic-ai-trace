// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app";
import { SIDEBAR_STEP, SIDEBAR_WIDTH } from "../sidebarWidth";
import { embed, payloadFromRuns } from "../testing/payload";

const WIDTH_KEY = "paitrace-sidebar-width";

// An in-memory localStorage: whether jsdom's is reachable depends on the Node version.
let stored: Map<string, string>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
});

afterEach(() => {
  cleanup();
  delete window.__TRACE_PAYLOAD__;
  vi.unstubAllGlobals();
});

/** Renders an exported run tree, which has a runs sidebar, and returns its resize handle. */
function renderSidebar() {
  const run = (id: string) => ({
    id,
    name: id,
    messages: [{ kind: "response" as const, parts: [{ part_kind: "text" as const, content: id }] }],
  });
  embed(
    payloadFromRuns([
      run("root"),
      { ...run("child"), parent: { run_id: "root", tool_call_id: null } },
    ]),
  );
  const view = render(<App />);
  const handle = view.getByRole("separator", { name: "Resize sidebar" });
  const width = () => Number(handle.getAttribute("aria-valuenow"));
  const cssWidth = () => handle.parentElement!.style.getPropertyValue("--sidebar-width");
  return { ...view, handle, width, cssWidth };
}

describe("sidebar resizing", () => {
  it("is a vertical separator that resizes with the keys and remembers the width", () => {
    const { handle, width, cssWidth, unmount } = renderSidebar();
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(cssWidth()).toBe(`${SIDEBAR_WIDTH.default}px`);
    // Focus stays on the handle: the trace's arrow-key shortcuts must not see the keys.
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(document.activeElement).toBe(handle);
    expect(width()).toBe(SIDEBAR_WIDTH.default + SIDEBAR_STEP);
    expect(cssWidth()).toBe(`${SIDEBAR_WIDTH.default + SIDEBAR_STEP}px`);
    expect(stored.get(WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH.default + SIDEBAR_STEP));
    unmount();

    expect(renderSidebar().width()).toBe(SIDEBAR_WIDTH.default + SIDEBAR_STEP);
  });

  it("follows a drag, clamped to the minimum, and resets on double-click", () => {
    const { handle, width } = renderSidebar();
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 330 });
    expect(width()).toBe(SIDEBAR_WIDTH.default + 50);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 });
    expect(width()).toBe(SIDEBAR_WIDTH.min);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    expect(stored.has(WIDTH_KEY)).toBe(false); // stored once, when the drag ends

    // The browser releases capture on pointerup; later moves no longer resize.
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    expect(stored.get(WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH.min));
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    expect(width()).toBe(SIDEBAR_WIDTH.min);

    fireEvent.dblClick(handle);
    expect(width()).toBe(SIDEBAR_WIDTH.default);
    expect(stored.get(WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH.default));
  });

  it("starts from a stored width and works without storage", () => {
    stored.set(WIDTH_KEY, "400");
    const remembered = renderSidebar();
    expect(remembered.width()).toBe(400);
    remembered.unmount();

    // A sandboxed iframe throws on any access to localStorage.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });
    const { handle, width } = renderSidebar();
    expect(width()).toBe(SIDEBAR_WIDTH.default);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(width()).toBe(SIDEBAR_WIDTH.default - SIDEBAR_STEP);
  });
});
