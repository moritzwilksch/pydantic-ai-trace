import { describe, expect, it } from "vitest";
import { formatHash, parseHash, type ViewLocation } from "./selection";

describe("view location in the URL hash", () => {
  it.each<[string, ViewLocation]>([
    ["#/run.json", { trace: { path: "run.json" } }],
    ["#/a/b.jsonl:3", { trace: { path: "a/b.jsonl", line: 3 } }],
    ["#/a/b.jsonl:3?run=helper", { trace: { path: "a/b.jsonl", line: 3 }, run: "helper" }],
    ["#?run=helper", { trace: null, run: "helper" }],
  ])("reads and writes %s", (hash, view) => {
    expect(parseHash(hash)).toEqual({ run: undefined, ...view });
    expect(formatHash(view)).toBe(hash);
  });

  it.each<ViewLocation>([
    { trace: { path: "dir with space/odd?name:7%.json", line: 2 }, run: "a&b=c#d?e f" },
    { trace: { path: "x.json" }, run: "" },
    { trace: null, run: "019a-uuid/1" },
    { trace: null },
  ])("round-trips %j", (view) => {
    expect(parseHash(formatHash(view))).toEqual({ run: undefined, ...view });
  });

  it("names no trace or run for an empty hash", () => {
    expect(parseHash("")).toEqual({ trace: null, run: undefined });
    expect(parseHash("#")).toEqual({ trace: null, run: undefined });
  });
});
