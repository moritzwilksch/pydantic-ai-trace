// @vitest-environment jsdom

import { render } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

/** Every attribute value that mentions `host`, except link targets. */
function loadedUrls(root: Element, host: string): string[] {
  return [...root.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes]
      .filter((attribute) => attribute.value.includes(host))
      .filter((attribute) => !(element.tagName === "A" && attribute.name === "href"))
      .map((attribute) => `<${element.tagName.toLowerCase()} ${attribute.name}>`),
  );
}

describe("Markdown", () => {
  it("links remote images instead of loading them", () => {
    const source = [
      "![chart](https://tracker.test/md.png)",
      '<img src="https://tracker.test/html.png" alt="raw">',
      '<img srcset="https://tracker.test/set.png 1x">',
      '<picture><source srcset="https://tracker.test/source.png"></picture>',
      '<video poster="https://tracker.test/poster.png" src="https://tracker.test/v.mp4"></video>',
      '<audio src="https://tracker.test/a.mp3"></audio>',
      '<table background="https://tracker.test/bg.png"><tr><td>x</td></tr></table>',
      '<div style="background-image: url(https://tracker.test/css.png)">styled</div>',
      '<svg><image href="https://tracker.test/svg.png"></image></svg>',
      '<input type="image" src="https://tracker.test/input.png">',
    ].join("\n\n");
    const { container } = render(<Markdown source={source} />);

    expect(loadedUrls(container, "tracker.test")).toEqual([]);
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "chart");
    expect(link?.getAttribute("href")).toBe("https://tracker.test/md.png");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("keeps inline data images and drops script URLs", () => {
    const source = `![pixel](${PIXEL})\n\n![bad](javascript:alert(1))`;
    const { container } = render(<Markdown source={source} />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(PIXEL);
    expect(container.innerHTML).not.toContain("javascript:");
  });
});
