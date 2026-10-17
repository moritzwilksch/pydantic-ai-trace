// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceSearch } from "./TraceSearch";

class TestHighlight {
  priority = 0;
  type: HighlightType = "highlight";
  readonly ranges: AbstractRange[];

  constructor(...ranges: AbstractRange[]) {
    this.ranges = ranges;
  }

  forEach(callback: (value: AbstractRange, key: AbstractRange, parent: Highlight) => void): void {
    for (const range of this.ranges) callback(range, range, this as unknown as Highlight);
  }
}

const highlights = new Map<string, Highlight>();

beforeEach(() => {
  highlights.clear();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", TestHighlight);
});

afterEach(() => {
  cleanup();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.unstubAllGlobals();
});

describe("TraceSearch", () => {
  it("activates the first match while typing, opens its collapsed parents, and highlights all matches", async () => {
    const rootRef = createRef<HTMLDivElement>();
    const { getByRole, getByText } = render(
      <>
        <TraceSearch rootRef={rootRef} />
        <div ref={rootRef}>
          <div class="part" data-nav>
            <details>
              <summary>
                Label <span class="block-preview">needle duplicate preview</span>
              </summary>
              <div>
                <span>Needle </span>
                <strong>across markup</strong> and another needle
                <button>needle control</button>
              </div>
            </details>
          </div>
        </div>
      </>,
    );
    const input = getByRole("searchbox", { name: "Search trace" });
    input.focus();

    fireEvent.input(input, { target: { value: "needle" } });

    await waitFor(() => expect(getByText("1 / 2")).not.toBeNull());
    expect(rootRef.current!.querySelector("details")!.open).toBe(true);
    expect(rootRef.current!.querySelector(".part")!.classList.contains("kb-focus")).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(
      (highlights.get("trace-search-current") as unknown as TestHighlight).ranges,
    ).toHaveLength(1);
    expect((highlights.get("trace-search-match") as unknown as TestHighlight).ranges).toHaveLength(
      2,
    );
  });

  it("matches across text nodes and wraps forward and backward navigation", async () => {
    const rootRef = createRef<HTMLDivElement>();
    const { getByRole, getByText } = render(
      <>
        <TraceSearch rootRef={rootRef} />
        <div ref={rootRef}>
          <div class="part">
            <span>bold </span>
            <strong>move</strong>
          </div>
          <div class="part">A second bold move.</div>
        </div>
      </>,
    );
    const input = getByRole("searchbox", { name: "Search trace" });

    fireEvent.input(input, { target: { value: "bold move" } });
    await waitFor(() => expect(getByText("1 / 2")).not.toBeNull());

    fireEvent.click(getByRole("button", { name: "Next search match" }));
    getByText("2 / 2");
    fireEvent.keyDown(input, { key: "Enter" });
    getByText("1 / 2");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    getByText("2 / 2");
  });

  it("clears search and keeps revealed blocks open with Escape", async () => {
    const rootRef = createRef<HTMLDivElement>();
    const { getByRole, queryByText } = render(
      <>
        <TraceSearch rootRef={rootRef} />
        <div ref={rootRef}>
          <div class="part">
            <details>
              <summary>Value</summary>
              <div>hidden target</div>
            </details>
          </div>
        </div>
      </>,
    );
    const input = getByRole("searchbox", { name: "Search trace" });

    fireEvent.input(input, { target: { value: "target" } });
    await waitFor(() => expect(rootRef.current!.querySelector("details")!.open).toBe(true));
    fireEvent.keyDown(input, { key: "Escape" });

    expect((input as HTMLInputElement).value).toBe("");
    expect(document.activeElement).not.toBe(input);
    expect(queryByText("1 / 1")).toBeNull();
    expect(rootRef.current!.querySelector("details")!.open).toBe(true);
    expect(highlights.size).toBe(0);
  });

  it("keeps the current match without scrolling when the trace re-renders", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const rootRef = createRef<HTMLDivElement>();
    const { getByRole, getByText } = render(
      <>
        <TraceSearch rootRef={rootRef} />
        <div ref={rootRef}>
          <div class="part">first target</div>
          <div class="part">second target</div>
        </div>
      </>,
    );
    const input = getByRole("searchbox", { name: "Search trace" });
    fireEvent.input(input, { target: { value: "target" } });
    await waitFor(() => getByText("1 / 2"));
    fireEvent.keyDown(input, { key: "Enter" });
    getByText("2 / 2");
    scrollIntoView.mockClear();

    const appended = document.createElement("div");
    appended.className = "part";
    appended.textContent = "third target";
    rootRef.current!.append(appended);

    await waitFor(() => getByText("2 / 3"));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("falls back to mark elements when custom highlights are unavailable", async () => {
    vi.stubGlobal("CSS", {});
    vi.stubGlobal("Highlight", undefined);
    const rootRef = createRef<HTMLDivElement>();
    const { getByRole, getByText } = render(
      <>
        <TraceSearch rootRef={rootRef} />
        <div ref={rootRef}>
          <div class="part">first target and second target</div>
        </div>
      </>,
    );
    const input = getByRole("searchbox", { name: "Search trace" });

    fireEvent.input(input, { target: { value: "target" } });
    await waitFor(() => expect(getByText("1 / 2")).not.toBeNull());
    expect(rootRef.current!.querySelectorAll("mark.trace-search-mark")).toHaveLength(2);
    expect(rootRef.current!.querySelectorAll("mark.current")).toHaveLength(1);

    fireEvent.keyDown(input, { key: "Enter" });
    getByText("2 / 2");
    expect(rootRef.current!.querySelectorAll("mark.trace-search-mark")).toHaveLength(2);
    expect(rootRef.current!.querySelectorAll("mark.current")).toHaveLength(1);
    expect(rootRef.current!.querySelector("mark.current")!.parentElement!.textContent).toBe(
      "first target and second target",
    );
  });
});
