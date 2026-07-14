// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { TreePane } from "./TreePane";
import type { TreeNode } from "../types";

const TREE: TreeNode = {
  name: "fixtures",
  path: ".",
  type: "dir",
  children: [
    {
      name: "media_and_builtins.json",
      path: "runs/media_and_builtins.json",
      type: "file",
      format: "json",
      trace_count: 1,
    },
    {
      name: "broken.json",
      path: "broken.json",
      type: "file",
      format: "json",
      trace_count: 1,
      error: true,
      error_message: "not a JSON array of messages",
    },
  ],
};

describe("TreePane", () => {
  it("filters by filename and explains when no traces match", () => {
    const { getByPlaceholderText, getByText, queryByText } = render(
      <TreePane root={TREE} rootLabel="fixtures" selection={null} onSelect={() => undefined} />,
    );
    const filter = getByPlaceholderText("Filter traces…");

    fireEvent.input(filter, { target: { value: "media" } });
    expect(getByText("media_and_builtins.json")).not.toBeNull();
    expect(queryByText("broken.json")).toBeNull();

    fireEvent.input(filter, { target: { value: "missing" } });
    expect(getByText("No traces match “missing”.")).not.toBeNull();
  });

  it("lets users inspect an invalid trace and exposes its diagnostic", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <TreePane root={TREE} rootLabel="fixtures" selection={null} onSelect={onSelect} />,
    );
    const broken = getByRole("button", { name: "broken.jsoninvalid" });

    expect(broken.getAttribute("title")).toBe("not a JSON array of messages");
    fireEvent.click(broken);
    expect(onSelect).toHaveBeenCalledWith({ path: "broken.json" });
  });
});
