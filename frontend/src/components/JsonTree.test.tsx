// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { unmountAll } from "../testing/unmount";
import { JSON_PAGE_SIZE, JsonTree } from "./JsonTree";
import { TraceSearch, TraceSearchScope } from "./TraceSearch";

afterEach(unmountAll);

/** A page of filler rows followed by one held-back row. */
function withHiddenRow(row: unknown): unknown[] {
  return [...Array.from({ length: JSON_PAGE_SIZE }, (_, i) => `row-${i}`), row];
}

function renderSearchable(value: unknown) {
  const rootRef = createRef<HTMLDivElement>();
  const view = render(
    <TraceSearchScope resetKey="">
      <TraceSearch rootRef={rootRef} />
      <div ref={rootRef}>
        <div class="part">
          <JsonTree value={value} />
        </div>
      </div>
    </TraceSearchScope>,
  );
  const search = (query: string) =>
    fireEvent.input(view.getByRole("searchbox", { name: "Search trace" }), {
      target: { value: query },
    });
  return { ...view, search };
}

describe("JsonTree search", () => {
  it.each([
    ["a key and its quoted value", 'name: "Ada'],
    ["an unquoted multi-line string", "text: first"],
    ["adjacent primitives", "n: 42ok: true"],
    ["null and an empty container", "none: nullempty: []"],
    ["case-insensitively", "ADA"],
  ])("reveals a held-back entry matched by %s", async (_, query) => {
    const row = { name: "Ada", text: "first\nsecond", n: 42, ok: true, none: null, empty: [] };
    const { queryByText, getByText, search } = renderSearchable(withHiddenRow(row));
    getByText("show 1 more");

    search(query);

    await waitFor(() => getByText("1 / 1"));
    expect(queryByText("show 1 more")).toBeNull();
  });

  it("keeps entries hidden when the query matches only text that is never rendered", async () => {
    const { getByText, search } = renderSearchable(withHiddenRow({ text: "first\nsecond" }));

    search('"first');

    await waitFor(() => getByText("0 / 0"));
    getByText("show 1 more");
  });

  it("reveals a match that starts in the last shown entry and ends in a held-back one", async () => {
    const { getByText, search } = renderSearchable(withHiddenRow("tail"));

    search(`"row-${JSON_PAGE_SIZE - 1}"${JSON_PAGE_SIZE}: "ta`);

    await waitFor(() => getByText("1 / 1"));
  });
});
