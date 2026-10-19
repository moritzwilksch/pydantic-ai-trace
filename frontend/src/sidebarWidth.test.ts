import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  keyedSidebarWidth,
  parseSidebarWidth,
  SIDEBAR_STEP,
  SIDEBAR_STEP_LARGE,
  SIDEBAR_WIDTH,
} from "./sidebarWidth";

describe("sidebar width", () => {
  it.each([
    [0, SIDEBAR_WIDTH.min],
    [SIDEBAR_WIDTH.max + 1, SIDEBAR_WIDTH.max],
    [300.4, 300],
  ])("clamps %d to %d", (width, clamped) => {
    expect(clampSidebarWidth(width)).toBe(clamped);
  });

  it.each([
    ["320", 320],
    ["9999", SIDEBAR_WIDTH.max],
    [null, SIDEBAR_WIDTH.default],
    ["", SIDEBAR_WIDTH.default],
    ["wide", SIDEBAR_WIDTH.default],
    ["Infinity", SIDEBAR_WIDTH.default],
  ])("reads the stored value %j as %d", (stored, width) => {
    expect(parseSidebarWidth(stored)).toBe(width);
  });

  it("steps with the arrow keys, further with Shift, and jumps with Home and End", () => {
    expect(keyedSidebarWidth(300, "ArrowRight", false)).toBe(300 + SIDEBAR_STEP);
    expect(keyedSidebarWidth(300, "ArrowLeft", true)).toBe(300 - SIDEBAR_STEP_LARGE);
    expect(keyedSidebarWidth(SIDEBAR_WIDTH.min, "ArrowLeft", false)).toBe(SIDEBAR_WIDTH.min);
    expect(keyedSidebarWidth(300, "Home", false)).toBe(SIDEBAR_WIDTH.min);
    expect(keyedSidebarWidth(300, "End", false)).toBe(SIDEBAR_WIDTH.max);
    expect(keyedSidebarWidth(300, "ArrowUp", false)).toBeNull();
  });
});
