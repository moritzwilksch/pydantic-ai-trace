// @vitest-environment jsdom

import { render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { unmountAll } from "../../testing/unmount";
import { MediaContent } from "./common";

afterEach(unmountAll);

// Bytes fa fb fc fd fe ff as Pydantic dumps them: URL-safe base64.
const URL_SAFE = "-vv8_f7_";

describe("MediaContent for binary content", () => {
  it("renders an image from URL-safe base64 as a standard data URL, captioned", () => {
    const item = {
      kind: "binary",
      data: URL_SAFE,
      media_type: "image/png",
      identifier: "receipt.png",
    };
    const { container, getByText } = render(<MediaContent item={item} />);

    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("data:image/png;base64,+vv8/f7/");
    expect(img.getAttribute("alt")).toBe("receipt.png");
    getByText("receipt.png");
  });

  it("labels a non-image chip with its identifier and media type", () => {
    const item = {
      kind: "binary",
      data: URL_SAFE,
      media_type: "application/pdf",
      identifier: "invoice.pdf",
    };
    const { getByText } = render(<MediaContent item={item} />);

    getByText("invoice.pdf · application/pdf");
  });
});
