// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/preact";
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
import { fetchTrace } from "./api";
import { payloadFromMessages } from "./testing/payload";

const mockedFetchTrace = vi.mocked(fetchTrace);

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
