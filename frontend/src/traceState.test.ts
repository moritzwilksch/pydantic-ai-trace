import { describe, expect, it } from "vitest";
import { payloadFromMessages } from "./testing/payload";
import { traceFailed, type ShownTrace, type TraceState } from "./traceState";

const run = { path: "run.json" };
const ready: ShownTrace = {
  status: "ready",
  selection: run,
  data: payloadFromMessages([{ kind: "response", parts: [{ part_kind: "text", content: "hi" }] }]),
};

describe("traceFailed", () => {
  it("keeps the shown trace when its reload fails", () => {
    expect(traceFailed(ready, { path: "run.json" }, "not valid JSON")).toEqual({
      status: "stale",
      shown: ready,
      message: "not valid JSON",
    });
  });

  it("keeps the last valid trace across repeated failures, with the latest error", () => {
    const stale = traceFailed(ready, run, "first");
    expect(traceFailed(stale, run, "second")).toEqual({
      status: "stale",
      shown: ready,
      message: "second",
    });
  });

  it("shows the error when the trace never loaded", () => {
    const states: TraceState[] = [
      { status: "unselected" },
      { status: "loading", previous: null },
      { status: "error", message: "old" },
    ];
    for (const state of states) {
      expect(traceFailed(state, run, "broken")).toEqual({ status: "error", message: "broken" });
    }
  });

  it("shows the error when another trace fails to load", () => {
    const loading: TraceState = { status: "loading", previous: ready };
    expect(traceFailed(loading, { path: "other.json" }, "broken")).toEqual({
      status: "error",
      message: "broken",
    });
    expect(traceFailed(ready, { path: "run.json", line: 2 }, "broken").status).toBe("error");
  });
});
