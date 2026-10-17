// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/preact";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import styles from "../styles/index.css?raw";
import { Block } from "./Block";

const LONG_PREVIEW = "x".repeat(120);

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
});

afterEach(cleanup);

function isShown(element: Element): boolean {
  return getComputedStyle(element).display !== "none";
}

describe("Block", () => {
  it("shows the preview and a more hint while collapsed, neither once open", () => {
    const { container } = render(
      <Block label="Tool return" preview={LONG_PREVIEW}>
        body
      </Block>,
    );
    const details = container.querySelector("details")!;
    const preview = container.querySelector(".block-preview")!;
    const more = container.querySelector(".preview-more")!;
    expect(isShown(preview)).toBe(true);
    expect(isShown(more)).toBe(true);

    details.open = true;

    expect(isShown(preview)).toBe(false);
    expect(isShown(more)).toBe(false);
  });

  it("omits the more hint for a preview that fits", () => {
    const { container } = render(
      <Block label="Text" preview="short">
        body
      </Block>,
    );
    expect(container.querySelector(".preview-more")).toBeNull();
  });
});
