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

  it("nests the selected trace's runs under the selected JSONL line only", () => {
    const tree: TreeNode = {
      name: "fixtures",
      path: ".",
      type: "dir",
      children: [
        { name: "runs.jsonl", path: "runs.jsonl", type: "file", format: "jsonl", trace_count: 2 },
      ],
    };
    const { getByRole } = render(
      <TreePane
        root={tree}
        rootLabel="fixtures"
        selection={{ path: "runs.jsonl", line: 2 }}
        onSelect={() => undefined}
        selectedChildren={<button>planner</button>}
      />,
    );

    const planner = getByRole("button", { name: "planner" });
    const line2 = getByRole("button", { name: "trace 2" });
    expect(line2.parentElement!.contains(planner)).toBe(true);
    expect(getByRole("button", { name: "trace 1" }).parentElement!.contains(planner)).toBe(false);
  });
});
