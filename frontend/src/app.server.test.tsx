// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  embeddedTrace: () => null,
  embeddedTraceCollection: () => null,
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
import { fetchTrace } from "./api";

const mockedFetchTrace = vi.mocked(fetchTrace);

beforeEach(() => {
  location.hash = "#/run.json";
  mockedFetchTrace.mockReset();
});

afterEach(() => {
  location.hash = "";
});

describe("App in server mode", () => {
  it("explains that a successfully loaded empty trace has no messages", async () => {
    mockedFetchTrace.mockResolvedValue({ source: "[]", transcript: "empty trace" });
    const { getByText } = render(<App />);

    await waitFor(() => expect(getByText("This trace contains no messages.")).toBeTruthy());
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
});
