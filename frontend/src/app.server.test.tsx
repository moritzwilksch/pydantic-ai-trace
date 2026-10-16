// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  embeddedPayload: () => null,
  fetchMeta: vi.fn(() => Promise.resolve({ mode: "dir", root: "traces" })),
  fetchTree: vi.fn(() =>
    Promise.resolve({
      name: "traces",
      path: ".",
      type: "dir",
      children: [{ name: "run.json", path: "run.json", type: "file", format: "json" }],
    }),
  ),
  fetchTrace: vi.fn(),
  subscribeChanges: vi.fn(() => () => undefined),
}));

import { App } from "./app";
import { fetchTrace, fetchTree, subscribeChanges } from "./api";
import { payloadFromMessages } from "./testing/payload";
import type { TracePayload, TreeNode } from "./types";

const mockedFetchTrace = vi.mocked(fetchTrace);

function textPayload(content: string): TracePayload {
  return payloadFromMessages([{ kind: "response", parts: [{ part_kind: "text", content }] }]);
}

function treeWith(fileName: string): TreeNode {
  return {
    name: "traces",
    path: ".",
    type: "dir",
    children: [
      { name: "run.json", path: "run.json", type: "file", format: "json" },
      { name: fileName, path: fileName, type: "file", format: "json" },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Captures the change listener the app subscribes. */
function captureChanges(): (paths: string[]) => void {
  let listener: ((paths: string[]) => void) | undefined;
  vi.mocked(subscribeChanges).mockImplementationOnce((onChange) => {
    listener = onChange;
    return () => undefined;
  });
  return (paths) => listener!(paths);
}

beforeEach(() => {
  location.hash = "#/run.json";
  mockedFetchTrace.mockReset();
});

afterEach(() => {
  location.hash = "";
});

describe("App in server mode", () => {
  it("renders the selected trace's payload", async () => {
    mockedFetchTrace.mockResolvedValue(
      payloadFromMessages([{ kind: "response", parts: [{ part_kind: "text", content: "hi" }] }]),
    );
    const { getAllByText } = render(<App />);

    await waitFor(() => expect(getAllByText("hi").length).toBeGreaterThan(0));
  });

  it("keeps the previous trace on screen while the next one loads", async () => {
    const first = payloadFromMessages([
      { kind: "response", parts: [{ part_kind: "text", content: "first" }] },
    ]);
    mockedFetchTrace.mockImplementation((selection) =>
      selection.path === "run.json" ? Promise.resolve(first) : new Promise(() => undefined),
    );
    const { container, getAllByText, queryByText } = render(<App />);
    await waitFor(() => expect(getAllByText("first").length).toBeGreaterThan(0));
    const header = container.querySelector(".trace-header")!.innerHTML;

    location.hash = "#/other.json";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() =>
      expect(mockedFetchTrace).toHaveBeenCalledWith({ path: "other.json", line: undefined }),
    );

    expect(queryByText("Loading trace…")).toBeNull();
    getAllByText("first");
    expect(container.querySelector(".trace-header")!.innerHTML).toBe(header);
  });

  it("shows loading while the selected trace is pending", async () => {
    mockedFetchTrace.mockReturnValue(new Promise(() => undefined));
    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText("Loading trace…")).toBeTruthy());
  });

  it("shows a trace fetch failure instead of an empty view", async () => {
    mockedFetchTrace.mockRejectedValue(new Error("run.json was removed"));
    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText("Error: run.json was removed")).toBeTruthy());
  });

  it("keeps the newest reload when an older one resolves last", async () => {
    const change = captureChanges();
    mockedFetchTrace.mockResolvedValueOnce(textPayload("initial"));
    const { getAllByText, queryByText } = render(<App />);
    await waitFor(() => expect(getAllByText("initial").length).toBeGreaterThan(0));

    const older = deferred<TracePayload>();
    const newer = deferred<TracePayload>();
    mockedFetchTrace.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    change(["run.json"]);
    change(["run.json"]);
    await act(async () => newer.resolve(textPayload("second save")));
    await act(async () => older.resolve(textPayload("first save")));

    expect(getAllByText("second save").length).toBeGreaterThan(0);
    expect(queryByText("first save")).toBeNull();
  });

  it("keeps the newest tree when an older refresh resolves last", async () => {
    const change = captureChanges();
    mockedFetchTrace.mockResolvedValue(textPayload("hi"));
    const { getAllByText, getByText, queryByText } = render(<App />);
    await waitFor(() => expect(getAllByText("hi").length).toBeGreaterThan(0));

    const older = deferred<TreeNode>();
    const newer = deferred<TreeNode>();
    vi.mocked(fetchTree).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    change(["other.json"]);
    change(["other.json"]);
    await act(async () => newer.resolve(treeWith("new.json")));
    await act(async () => older.resolve(treeWith("old.json")));

    expect(getByText("new.json")).toBeTruthy();
    expect(queryByText("old.json")).toBeNull();
  });
});
