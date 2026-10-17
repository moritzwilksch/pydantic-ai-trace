// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACE_LINE_PAGE, TreePane } from "./TreePane";
import type { TraceSummary, TreeNode } from "../types";

function jsonl(path: string, traces: Partial<TraceSummary>[]): TreeNode {
  return {
    name: path.split("/").at(-1)!,
    path,
    type: "file",
    format: "jsonl",
    trace_count: traces.length,
    error: false,
    traces: traces.map((trace, i) => ({
      line: i + 1,
      error: false,
      prompt: null,
      answer: null,
      models: [],
      ...trace,
    })),
  };
}

/** A JSONL file of `count` traces without prompts, labelled "trace N". */
function unlabelled(path: string, count: number): TreeNode {
  return jsonl(
    path,
    Array.from({ length: count }, () => ({})),
  );
}

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
  afterEach(() => {
    cleanup();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    vi.restoreAllMocks();
  });

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
      children: [unlabelled("runs.jsonl", 2)],
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

  it("lists a large JSONL file one page at a time", () => {
    const log = unlabelled("evals.jsonl", TRACE_LINE_PAGE * 2 + 50);
    const { container, rerender } = render(
      <TreePane root={log} rootLabel="evals" selection={null} onSelect={() => undefined} />,
    );
    const { getByRole, queryAllByRole } = within(container as HTMLElement);
    const traceButtons = () => queryAllByRole("button", { name: /^trace \d+$/ });

    expect(traceButtons()).toHaveLength(TRACE_LINE_PAGE);
    fireEvent.click(getByRole("button", { name: `show ${TRACE_LINE_PAGE} more of 150` }));
    expect(traceButtons()).toHaveLength(TRACE_LINE_PAGE * 2);
    fireEvent.click(getByRole("button", { name: "show 50 more of 50" }));
    expect(traceButtons()).toHaveLength(250);
    expect(queryAllByRole("button", { name: /^show / })).toHaveLength(0);

    rerender(
      <TreePane
        key="fresh"
        root={log}
        rootLabel="evals"
        selection={{ path: "evals.jsonl", line: 240 }}
        onSelect={() => undefined}
      />,
    );
    expect(traceButtons()).toHaveLength(TRACE_LINE_PAGE + 1);
    expect(getByRole("button", { name: "trace 240" }).className).toContain("selected");
  });

  it("labels JSONL traces by line and prompt, and flags an invalid one", () => {
    const log = jsonl("evals.jsonl", [
      { prompt: "What is the capital of Australia?", answer: "Canberra.", models: ["gpt-5-nano"] },
      { error: true, error_message: "not valid JSON" },
    ]);
    const { getByRole } = render(
      <TreePane root={log} rootLabel="evals" selection={null} onSelect={() => undefined} />,
    );

    const first = getByRole("button", { name: "1What is the capital of Australia?" });
    expect(first.getAttribute("title")).toBe(
      "trace 1 · gpt-5-nano\nWhat is the capital of Australia?\n→ Canberra.",
    );
    const broken = getByRole("button", { name: "trace 2invalid" });
    expect(broken.getAttribute("aria-invalid")).toBe("true");
    expect(broken.getAttribute("title")).toBe("not valid JSON");
    expect(getByRole("button", { name: "evals.jsonl21 invalid" })).not.toBeNull();
  });

  it("collapses folders and starts a JSONL file collapsed unless it holds the selection", () => {
    const tree: TreeNode = {
      name: "fixtures",
      path: ".",
      type: "dir",
      children: [
        { name: "evals", path: "evals", type: "dir", children: [unlabelled("evals/a.jsonl", 2)] },
        unlabelled("b.jsonl", 2),
      ],
    };
    const { getByRole, queryAllByRole } = render(
      <TreePane
        root={tree}
        rootLabel="fixtures"
        selection={{ path: "b.jsonl", line: 2 }}
        onSelect={() => undefined}
      />,
    );
    const traceButtons = () => queryAllByRole("button", { name: /^trace \d+$/ });
    const folder = getByRole("button", { name: "evals" });
    const evalsLog = getByRole("button", { name: "a.jsonl2" });

    expect(evalsLog.getAttribute("aria-expanded")).toBe("false");
    expect(traceButtons()).toHaveLength(2); // b.jsonl's
    fireEvent.click(evalsLog);
    expect(traceButtons()).toHaveLength(4);

    fireEvent.click(folder);
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    expect(queryAllByRole("button", { name: "a.jsonl2" })).toHaveLength(0);
    expect(traceButtons()).toHaveLength(2);
  });

  it("filters traces by prompt, answer, and model, keeping only the matching lines", () => {
    const tree: TreeNode = {
      name: "fixtures",
      path: ".",
      type: "dir",
      children: [
        jsonl("evals.jsonl", [
          {
            prompt: "What is the capital of Australia?",
            answer: "Canberra.",
            models: ["gpt-5-nano"],
          },
          { prompt: "Sum the numbers 1 to 100.", answer: "5050", models: ["claude-haiku"] },
        ]),
        {
          ...jsonl("chat.json", [{ prompt: "Refund order A-1043", models: ["gpt-5-mini"] }]),
          name: "chat.json",
          format: "json",
        },
      ],
    };
    const { getByPlaceholderText, getByRole, queryByRole, queryByText } = render(
      <TreePane root={tree} rootLabel="fixtures" selection={null} onSelect={() => undefined} />,
    );
    const filter = getByPlaceholderText("Filter traces…");

    for (const query of ["AUSTRALIA", "canberra"]) {
      fireEvent.input(filter, { target: { value: query } });
      expect(getByRole("button", { name: "1What is the capital of Australia?" })).not.toBeNull();
      expect(queryByRole("button", { name: "2Sum the numbers 1 to 100." })).toBeNull();
      expect(queryByText("chat.json")).toBeNull();
    }

    fireEvent.input(filter, { target: { value: "gpt-5" } });
    expect(getByRole("button", { name: "1What is the capital of Australia?" })).not.toBeNull();
    expect(queryByRole("button", { name: "2Sum the numbers 1 to 100." })).toBeNull();
    expect(queryByText("chat.json")).not.toBeNull();
  });

  it("opens the first visible match on Enter in the filter", () => {
    const tree: TreeNode = {
      name: "fixtures",
      path: ".",
      type: "dir",
      children: [
        {
          name: "evals",
          path: "evals",
          type: "dir",
          children: [
            jsonl("evals/qa.jsonl", [
              { prompt: "What is the capital of Australia?" },
              { prompt: "Sum the numbers 1 to 100." },
              { prompt: "Sum the primes below 10." },
            ]),
          ],
        },
        { name: "summary.json", path: "summary.json", type: "file", format: "json" },
      ],
    };
    const onSelect = vi.fn();
    const { getByPlaceholderText, getByRole } = render(
      <TreePane root={tree} rootLabel="fixtures" selection={null} onSelect={onSelect} />,
    );
    const filter = getByPlaceholderText("Filter traces…");
    const enter = (query: string) => {
      fireEvent.input(filter, { target: { value: query } });
      fireEvent.keyDown(filter, { key: "Enter" });
    };
    fireEvent.click(getByRole("button", { name: "evals" })); // collapse the folder

    enter("sum the");
    expect(onSelect).toHaveBeenLastCalledWith({ path: "evals/qa.jsonl", line: 2 });
    enter("qa.jsonl");
    expect(onSelect).toHaveBeenLastCalledWith({ path: "evals/qa.jsonl", line: 1 });
    enter("summary");
    expect(onSelect).toHaveBeenLastCalledWith({ path: "summary.json" });
    enter("missing");
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it("expands to a selection made elsewhere and centers it only when out of view", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // The tree body shows y 0-100; each "trace N" button sits at y 20N.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const line = /^trace (\d+)$/.exec(this.textContent ?? "");
      const top = line ? Number(line[1]) * 20 : 0;
      return { top, bottom: this.classList.contains("tree-body") ? 100 : top + 20 } as DOMRect;
    });
    const tree: TreeNode = {
      name: "fixtures",
      path: ".",
      type: "dir",
      children: [
        { name: "evals", path: "evals", type: "dir", children: [unlabelled("evals/a.jsonl", 80)] },
      ],
    };
    const view = (selection: { path: string; line: number } | null) => (
      <TreePane root={tree} rootLabel="fixtures" selection={selection} onSelect={() => undefined} />
    );
    const { getByRole, queryByRole, rerender } = render(view(null));
    fireEvent.click(getByRole("button", { name: "evals" })); // collapse the folder
    expect(queryByRole("button", { name: "trace 72" })).toBeNull();

    rerender(view({ path: "evals/a.jsonl", line: 72 }));
    expect(scrollIntoView.mock.contexts).toEqual([getByRole("button", { name: "trace 72" })]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });

    rerender(view({ path: "evals/a.jsonl", line: 2 }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
