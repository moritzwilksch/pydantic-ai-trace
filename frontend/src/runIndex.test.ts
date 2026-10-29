import { describe, expect, it } from "vitest";
import { indexRunTree } from "./runIndex";
import { payloadFromRuns } from "./testing/payload";

const text = (content: string) => [{ kind: "response", parts: [{ part_kind: "text", content }] }];

describe("indexRunTree", () => {
  it("treats an empty run ID as a run, not as a missing parent", () => {
    const runTree = indexRunTree(
      payloadFromRuns([
        { id: "", name: "root", messages: text("a") },
        {
          id: "child",
          name: "child",
          parent: { run_id: "", tool_call_id: null },
          messages: text("b"),
        },
        {
          id: "grandchild",
          name: "grandchild",
          parent: { run_id: "child", tool_call_id: null },
          messages: text("c"),
        },
      ]),
    );

    expect(runTree.roots.map((entry) => entry.run.name)).toEqual(["root"]);
    expect(runTree.children("").map((entry) => entry.run.name)).toEqual(["child"]);
    expect(runTree.ancestors("grandchild").map((entry) => entry.run.name)).toEqual([
      "root",
      "child",
    ]);
    expect(runTree.ancestors("")).toEqual([]);
  });

  it("orders runs as the payload's analysis does, without re-sorting", () => {
    const payload = payloadFromRuns([
      { id: "a", name: "a", messages: text("a") },
      { id: "b", name: "b", messages: text("b") },
      { id: "x", name: "x", parent: { run_id: "a", tool_call_id: null }, messages: text("x") },
      { id: "y", name: "y", parent: { run_id: "a", tool_call_id: null }, messages: text("y") },
    ]);
    payload.analysis.root_run_ids = ["b", "a"];
    payload.analysis.runs[0].child_run_ids = ["y", "x"];

    const runTree = indexRunTree(payload);

    expect(runTree.roots.map((entry) => entry.run.id)).toEqual(["b", "a"]);
    expect(runTree.children("a").map((entry) => entry.run.id)).toEqual(["y", "x"]);
  });
});
