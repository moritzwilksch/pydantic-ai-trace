// @vitest-environment jsdom

import { render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../../app";
import { embedMessages } from "../../testing/payload";
import { unmountAll } from "../../testing/unmount";

afterEach(async () => {
  await unmountAll();
  delete window.__TRACE_PAYLOAD__;
});

describe("text citations", () => {
  it("quotes each cited range and lists its sources, linking only web URLs", () => {
    // The emoji is one code point but two UTF-16 units; anchors count code points.
    const content = "🙂 Refunds take 5 days [1].";
    embedMessages([
      {
        kind: "response",
        parts: [
          {
            part_kind: "text",
            content,
            citations: [
              {
                anchor: { kind: "content", start: 2, end: 21 },
                sources: [
                  {
                    kind: "web",
                    url: "https://shop.example/refunds",
                    title: "Refund policy",
                    excerpts: ["within 5 business days"],
                  },
                  { kind: "web", url: "javascript:alert(1)", title: "Bad link", excerpts: [] },
                ],
              },
              {
                anchor: { kind: "marker", start: 22, end: 25 },
                sources: [
                  { kind: "document", document_id: "file_1", title: "policy.pdf", excerpts: [] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const { container, getByText } = render(<App />);

    expect(getByText("2 citations")).toBeTruthy();
    const quotes = [...container.querySelectorAll(".citations q")].map((q) => q.textContent);
    expect(quotes).toEqual(["Refunds take 5 days"]);
    expect(getByText("[1]").tagName).toBe("SPAN");
    expect(getByText("Refund policy").closest("a")?.getAttribute("href")).toBe(
      "https://shop.example/refunds",
    );
    expect(getByText("Bad link").closest("a")).toBeNull();
    getByText("within 5 business days");
    getByText("policy.pdf · file_1");
  });
});

describe("omitted usage", () => {
  it("says a response did not report usage instead of showing zero tokens", () => {
    embedMessages([
      {
        kind: "response",
        parts: [{ part_kind: "text", content: "hi" }],
        usage: { input_tokens: 0, output_tokens: 0, unmeasured_requests: 1 },
      },
    ]);
    const { container, getByText } = render(<App />);

    getByText("usage not reported");
    expect(container.querySelector(".card-footer")?.textContent).not.toContain("0 in");
    expect(container.querySelector(".trace-stats")?.textContent).toContain(
      "1 LLM calls (1 without usage)",
    );
  });
});
