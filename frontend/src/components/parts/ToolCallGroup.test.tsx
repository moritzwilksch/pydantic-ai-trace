// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app";
import { unmountAll } from "../../testing/unmount";
import { embedMessages } from "../../testing/payload";

const fetchRows = (id: string, offset: number) => ({
  part_kind: "tool-call",
  tool_name: "fetch_rows",
  args: { offset },
  tool_call_id: id,
});

const rowsReturned = (id: string, rows: string) => ({
  part_kind: "tool-return",
  tool_name: "fetch_rows",
  content: rows,
  tool_call_id: id,
});

beforeEach(() => {
  // jsdom implements no layout; focusing a part scrolls it into view.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  await unmountAll();
  delete window.__TRACE_PAYLOAD__;
});

/** The header of the block that contains `element`. */
const headerOf = (element: HTMLElement) => element.closest("details")!.querySelector("summary")!;

describe("tool call and result pairing", () => {
  it("shows each result with its call's number and arguments", () => {
    embedMessages([
      { kind: "response", parts: [fetchRows("a", 0), fetchRows("b", 50)] },
      // Results arrive out of call order; pairing follows the tool call ID.
      { kind: "request", parts: [rowsReturned("b", "rows 50-99"), rowsReturned("a", "rows 0-49")] },
    ]);
    const { getByText } = render(<App />);

    const header = (text: string) => headerOf(getByText(text));
    expect(header("rows 0-49").querySelector(".tool-signature")!.textContent).toBe(
      "fetch_rows(offset: 0)",
    );
    expect(header("rows 0-49").querySelector(".pair-link")!.textContent).toBe("#1");
    expect(header("rows 50-99").querySelector(".tool-signature")!.textContent).toBe(
      "fetch_rows(offset: 50)",
    );
    expect(header("rows 50-99").querySelector(".pair-link")!.textContent).toBe("#2");
  });

  it("jumps from a result to its call and back without toggling either block", () => {
    embedMessages([
      { kind: "response", parts: [fetchRows("a", 0), fetchRows("b", 50)] },
      { kind: "request", parts: [rowsReturned("b", "rows 50-99"), rowsReturned("a", "rows 0-49")] },
    ]);
    const { container, getByText, getByRole } = render(<App />);
    const part = (message: number, index: number) =>
      container.querySelector<HTMLElement>(`[data-part="${message}:${index}"]`)!;

    const result = getByText("rows 50-99").closest("details")!;
    fireEvent.click(getByRole("button", { name: "Jump to call #2" }));
    expect(part(0, 1).classList).toContain("kb-focus");
    expect(result.open).toBe(false);

    fireEvent.click(getByRole("button", { name: "Jump to result of call #2" }));
    expect(part(1, 0).classList).toContain("kb-focus");
    expect(part(0, 1).classList).not.toContain("kb-focus");
    expect(part(0, 1).querySelector("details")!.open).toBe(false);
  });

  it("marks calls and results without a counterpart", () => {
    embedMessages([
      { kind: "response", parts: [fetchRows("lost", 0), fetchRows("retried", 10)] },
      {
        kind: "request",
        parts: [
          rowsReturned("stray", "rows from nowhere"),
          {
            part_kind: "retry-prompt",
            tool_name: "fetch_rows",
            content: "offset out of range",
            tool_call_id: "retried",
          },
          {
            part_kind: "retry-prompt",
            tool_name: "fetch_rows",
            content: "unknown call",
            tool_call_id: "never-called",
          },
        ],
      },
    ]);
    const { getAllByText } = render(<App />);
    const header = (text: string) => headerOf(getAllByText(text)[0]);

    const unanswered = header("fetch_rows");
    expect(unanswered.querySelector(".pair-link")).toBeNull();
    expect(unanswered.querySelector(".pair-number")!.textContent).toBe("#1");
    expect(unanswered.textContent).toContain("no return recorded");

    expect(header("rows from nowhere").textContent).toContain("no matching call");
    expect(header("offset out of range").querySelector(".pair-link")!.ariaLabel).toBe(
      "Jump to call #2",
    );
    expect(header("unknown call").textContent).toContain("no matching call");
  });
});
