// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async (importOriginal) => ({
  FetchError: (await importOriginal<typeof import("./api")>()).FetchError,
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
import { FetchError, fetchMeta, fetchTrace, fetchTree, subscribeChanges } from "./api";
import { payloadFromMessages, payloadFromRuns } from "./testing/payload";
import type { TracePayload, TreeNode } from "./types";

const mockedFetchTrace = vi.mocked(fetchTrace);

function textPayload(content: string): TracePayload {
  return payloadFromMessages([{ kind: "response", parts: [{ part_kind: "text", content }] }]);
}

/** A worker run with a nested helper run. */
const WORKER_WITH_HELPER = payloadFromRuns([
  {
    id: "worker",
    name: "worker",
    messages: [{ kind: "response", parts: [{ part_kind: "text", content: "working" }] }],
  },
  {
    id: "helper",
    name: "helper",
    parent: { run_id: "worker", tool_call_id: null },
    messages: [{ kind: "response", parts: [{ part_kind: "text", content: "helped" }] }],
  },
]);

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
  cleanup();
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

  it("fetches a trace once per click in the tree", async () => {
    vi.mocked(fetchTree).mockResolvedValueOnce(treeWith("other.json"));
    mockedFetchTrace.mockResolvedValue(textPayload("hi"));
    const { getByText } = render(<App />);
    await waitFor(() => getByText("other.json"));

    const hashChanged = new Promise((resolve) =>
      window.addEventListener("hashchange", resolve, { once: true }),
    );
    fireEvent.click(getByText("other.json"));
    await act(async () => {
      await hashChanged;
    });

    const otherFetches = mockedFetchTrace.mock.calls.filter(([s]) => s.path === "other.json");
    expect(otherFetches).toHaveLength(1);
  });

  it("opens the sidebar from the header and closes it when a trace is selected", async () => {
    vi.mocked(fetchTree).mockResolvedValueOnce(treeWith("other.json"));
    mockedFetchTrace.mockResolvedValue(textPayload("hi"));
    const { getByPlaceholderText, getByRole, getByText } = render(<App />);
    await waitFor(() => getByText("other.json"));
    const toggle = getByRole("button", { name: "Show traces" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(getByPlaceholderText("Filter traces…"));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    fireEvent.click(getByText("other.json"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows loading while the selected trace is pending", async () => {
    mockedFetchTrace.mockReturnValue(new Promise(() => undefined));
    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText("Loading trace…")).toBeTruthy());
  });

  it("shows a trace fetch failure instead of an empty view", async () => {
    mockedFetchTrace.mockRejectedValue(new Error("run.json was removed"));
    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText("run.json was removed")).toBeTruthy());
  });

  it("expands every validation error of a broken trace", async () => {
    mockedFetchTrace.mockRejectedValue(
      new FetchError("run.json: runs.0.parent: Field required (+1 more)", [
        "runs.0.parent: Field required",
        "runs.0.outcome: Field required",
      ]),
    );
    const { getByText } = render(<App />);

    fireEvent.click(await waitFor(() => getByText("Show all 2 errors")));

    expect(getByText("runs.0.outcome: Field required")).toBeTruthy();
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

  it("keeps the last valid trace while the file is invalid, then shows the fix", async () => {
    const change = captureChanges();
    mockedFetchTrace.mockResolvedValueOnce(textPayload("saved"));
    const { getAllByText, getByRole, queryByRole } = render(<App />);
    await waitFor(() => expect(getAllByText("saved").length).toBeGreaterThan(0));

    mockedFetchTrace.mockRejectedValueOnce(new Error("'run.json' is not valid JSON"));
    await act(async () => change(["run.json"]));

    await waitFor(() =>
      expect(getByRole("status").textContent).toBe(
        "File currently invalid: 'run.json' is not valid JSON; showing last valid version.",
      ),
    );
    getAllByText("saved");

    mockedFetchTrace.mockResolvedValueOnce(textPayload("saved again"));
    await act(async () => change(["run.json"]));

    await waitFor(() => expect(getAllByText("saved again").length).toBeGreaterThan(0));
    expect(queryByRole("status")).toBeNull();
  });

  it("keeps the file-mode layout while the file is invalid", async () => {
    const change = captureChanges();
    const file: TreeNode = { name: "run.json", path: "run.json", type: "file", format: "json" };
    vi.mocked(fetchMeta).mockResolvedValueOnce({ mode: "file", root: "run.json" });
    vi.mocked(fetchTree).mockResolvedValueOnce(file);
    mockedFetchTrace.mockResolvedValueOnce(textPayload("saved"));
    const { container, getAllByText, getByRole } = render(<App />);
    await waitFor(() => expect(getAllByText("saved").length).toBeGreaterThan(0));

    vi.mocked(fetchTree).mockResolvedValueOnce({ ...file, error: true, error_message: "bad" });
    mockedFetchTrace.mockRejectedValueOnce(new Error("bad"));
    await act(async () => change(["run.json"]));

    await waitFor(() => getByRole("status"));
    expect(container.querySelector(".tree-pane")).toBeNull();
  });

  it("opens the run the URL names and records run switches in history", async () => {
    location.hash = "#/run.json?run=helper";
    mockedFetchTrace.mockResolvedValue(WORKER_WITH_HELPER);
    const { getAllByText, getByRole } = render(<App />);
    await waitFor(() => expect(getAllByText("helped").length).toBeGreaterThan(0));

    const runPath = getByRole("navigation", { name: "Run path" });
    fireEvent.click(within(runPath).getByRole("button", { name: "worker" }));
    getAllByText("working");
    expect(location.hash).toBe("#/run.json?run=worker");

    history.back();
    await waitFor(() => expect(getAllByText("helped").length).toBeGreaterThan(0));
    expect(location.hash).toBe("#/run.json?run=helper");
    expect(mockedFetchTrace).toHaveBeenCalledTimes(1); // switching runs reuses the loaded trace
  });

  it("opens another trace at its root run", async () => {
    vi.mocked(fetchTree).mockResolvedValueOnce(treeWith("other.json"));
    location.hash = "#/run.json?run=helper";
    mockedFetchTrace.mockResolvedValue(WORKER_WITH_HELPER);
    const { getAllByText, getByText } = render(<App />);
    await waitFor(() => expect(getAllByText("helped").length).toBeGreaterThan(0));

    fireEvent.click(getByText("other.json"));

    expect(location.hash).toBe("#/other.json");
    await waitFor(() => expect(getAllByText("working").length).toBeGreaterThan(0));
  });

  it("keeps the run the URL names while the file is invalid", async () => {
    const change = captureChanges();
    location.hash = "#/run.json?run=helper";
    mockedFetchTrace.mockResolvedValueOnce(WORKER_WITH_HELPER);
    const { getAllByText, getByRole } = render(<App />);
    await waitFor(() => expect(getAllByText("helped").length).toBeGreaterThan(0));

    mockedFetchTrace.mockRejectedValueOnce(new Error("'run.json' is not valid JSON"));
    await act(async () => change(["run.json"]));

    await waitFor(() => getByRole("status"));
    getAllByText("helped");
    expect(location.hash).toBe("#/run.json?run=helper");
  });
});
