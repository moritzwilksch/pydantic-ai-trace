import { describe, expect, it } from "vitest";
import { indexTrajectory } from "./runIndex";
import { payloadFromRuns } from "./testing/payload";

const text = (content: string) => [{ kind: "response", parts: [{ part_kind: "text", content }] }];

describe("indexTrajectory", () => {
  it("treats an empty run ID as a run, not as a missing parent", () => {
    const trajectory = indexTrajectory(
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

    expect(trajectory.roots.map((entry) => entry.run.name)).toEqual(["root"]);
    expect(trajectory.children("").map((entry) => entry.run.name)).toEqual(["child"]);
    expect(trajectory.ancestors("grandchild").map((entry) => entry.run.name)).toEqual([
      "root",
      "child",
    ]);
    expect(trajectory.ancestors("")).toEqual([]);
  });
});
