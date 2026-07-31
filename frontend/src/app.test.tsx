// @vitest-environment jsdom
// Render smoke test: the full app must render a realistic trace (the same
// shape `paitrace export` embeds) without crashing, covering every part renderer.

import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";

const FULL_TRACE = [
  {
    kind: "request",
    parts: [
      { part_kind: "system-prompt", content: "Be helpful.", timestamp: "2026-07-01T09:00:00Z" },
      {
        part_kind: "user-prompt",
        content: [
          "Look at this **image**:",
          { kind: "image-url", url: "https://example.com/x.png" },
          { kind: "binary", data: "aGk=", media_type: "application/pdf" },
          { kind: "cache-point" },
        ],
        timestamp: "2026-07-01T09:00:00Z",
      },
    ],
  },
  {
    kind: "response",
    parts: [
      { part_kind: "thinking", content: "pondering...", provider_name: "openai" },
      { part_kind: "tool-call", tool_name: "search", args: '{"q": "x"}', tool_call_id: "c1" },
      { part_kind: "tool-call", tool_name: "orphaned", args: null, tool_call_id: "gone" },
    ],
    usage: { input_tokens: 10, output_tokens: 4 },
    model_name: "test-model",
    timestamp: "2026-07-01T09:00:01Z",
    finish_reason: "tool_call",
  },
  {
    kind: "request",
    instructions: "Always answer in French.",
    parts: [
      { part_kind: "tool-return", tool_name: "search", content: { hits: 3 }, tool_call_id: "c1" },
      {
        part_kind: "tool-return",
        tool_name: "screenshot",
        tool_call_id: "orphan-media",
        content: ["Here is the page:", { kind: "binary", data: "aGk=", media_type: "image/png" }],
      },
      {
        part_kind: "retry-prompt",
        tool_name: "other",
        tool_call_id: "unrelated",
        content: [{ type: "missing", loc: ["q"], msg: "Field required", input: {} }],
      },
    ],
  },
  {
    kind: "response",
    parts: [
      {
        part_kind: "compaction",
        content: "Earlier: user asked about X.",
        provider_name: "anthropic",
      },
      { part_kind: "text", content: "All done, see `code`." },
      { part_kind: "some-future-part", payload: 42 },
    ],
    usage: { request_tokens: 20, response_tokens: 8 },
    model_name: "test-model",
    timestamp: "2026-07-01T09:00:05Z",
    finish_reason: "stop",
  },
];

afterEach(() => {
  cleanup();
  delete window.__TRACE_DATA__;
  delete window.__TRACE_NAME__;
  delete window.__TRACE_TEXT__;
});

describe("App in exported-trace mode", () => {
  it("renders every part kind of an embedded trace without crashing", () => {
    window.__TRACE_DATA__ = FULL_TRACE;
    window.__TRACE_NAME__ = "smoke.json";
    const { container, getByText, getAllByText } = render(<App />);

    getByText("smoke.json"); // header title
    getAllByText("Be helpful."); // system prompt (collapsed preview + body)
    getAllByText("search"); // tool call and its return in the original request
    getByText("no return recorded"); // orphan badge
    getByText("Field required"); // retry error table
    getByText("some-future-part"); // fallback for unknown kinds
    getByText("Compaction"); // compaction part label
    getAllByText("Instructions"); // request-level instructions block
    // tool return with media content renders the image, not a base64 dump
    const mediaReturn = getByText("screenshot").closest("details")!;
    expect(mediaReturn.querySelector("img")).not.toBeNull();
    expect(getAllByText("test-model").length).toBe(2); // response footers
    // Cards and parts remain in the same sequence as the source JSON.
    expect(getAllByText("Request").length).toBe(2);
    expect(getAllByText("Response").length).toBe(2);
    // aggregate stats include legacy usage aliases: 10 + 20 in
    expect(container.textContent).toContain("30");
    // input, cached, and output totals are always visible in the header.
    expect(container.textContent).toContain("0 cached");
  });

  it("copies the ordered text transcript", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.__TRACE_DATA__ = FULL_TRACE;
    window.__TRACE_NAME__ = "smoke.json";
    window.__TRACE_TEXT__ = "precomputed transcript";
    const { getByRole } = render(<App />);

    fireEvent.click(getByRole("button", { name: "Copy trace" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = writeText.mock.calls[0][0];
    expect(copied).toBe("precomputed transcript");
    getByRole("button", { name: "Copied" });
  });

  it("does not render a placeholder for thinking parts without content", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [
          { part_kind: "thinking", content: "", signature: "sig-only" },
          { part_kind: "text", content: "answer" },
        ],
      },
    ];
    const { container, getAllByText } = render(<App />);
    getAllByText("answer"); // text block preview + body
    expect(container.textContent).not.toContain("Thinking");
    // and no empty nav target either: only the text part is rendered
    expect(container.querySelectorAll("[data-nav]").length).toBe(1);
  });

  it("renders a paired result in its original request card", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [
          { part_kind: "thinking", content: "", signature: "signature-only" },
          { part_kind: "tool-call", tool_name: "search", args: "{}", tool_call_id: "c1" },
        ],
        state: "complete",
      },
      {
        kind: "request",
        parts: [
          { part_kind: "tool-return", tool_name: "search", content: "found", tool_call_id: "c1" },
        ],
        instructions: null,
        state: "complete",
      },
    ];

    const { container, getAllByText } = render(<App />);

    const responseCard = container.querySelector(".kind-response")!.closest(".card")!;
    const requestCard = container.querySelector(".kind-request")!.closest(".card")!;
    expect(responseCard.textContent).not.toContain("found");
    expect(requestCard.textContent).toContain("found");
    getAllByText("found");
  });

  it("shows diagnostics for a response without visible parts", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [{ part_kind: "thinking", content: "", signature: "sig-only" }],
        model_name: "diagnostic-model",
        provider_name: "diagnostic-provider",
        finish_reason: "content_filter",
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    ];

    const { container, getByText } = render(<App />);

    getByText("diagnostic-model");
    getByText("diagnostic-provider");
    getByText("finish: content_filter");
    expect(container.textContent).toContain("12 in");
  });

  it("shows instructions on a request without parts", () => {
    window.__TRACE_DATA__ = [
      { kind: "request", instructions: "Use the private index.", parts: [] },
    ];

    const { getAllByText } = render(<App />);

    getAllByText("Instructions");
    getAllByText("Use the private index.");
  });

  it("shows repeated instructions only after they change", () => {
    window.__TRACE_DATA__ = [
      { kind: "request", instructions: "First.", parts: [] },
      { kind: "request", instructions: "First.", parts: [] },
      { kind: "request", instructions: null, parts: [] },
      { kind: "response", parts: [] },
      { kind: "request", instructions: "Second.", parts: [] },
      { kind: "request", instructions: "Second.", parts: [] },
      { kind: "request", instructions: "First.", parts: [] },
    ];

    const { container, getAllByText } = render(<App />);
    const requestCards = Array.from(container.querySelectorAll(".kind-request")).map((header) =>
      header.closest(".card")!,
    );

    expect(requestCards.map((card) => card.textContent?.includes("Instructions"))).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
    ]);
    expect(getAllByText("Instructions")).toHaveLength(3);
  });

  it("expands and collapses every content block with uppercase E and C", () => {
    window.__TRACE_DATA__ = [
      { kind: "request", parts: [{ part_kind: "user-prompt", content: "question" }] },
      { kind: "response", parts: [{ part_kind: "text", content: "answer" }] },
    ];
    const { container } = render(<App />);
    const details = Array.from(
      container.querySelectorAll<HTMLDetailsElement>(".trace-body details"),
    );

    expect(details).toHaveLength(2);
    expect(details.every((block) => !block.open)).toBe(true);

    const tree = document.createElement("nav");
    tree.className = "tree-pane";
    const selectedTrace = document.createElement("button");
    tree.append(selectedTrace);
    container.append(tree);
    selectedTrace.focus();

    fireEvent.keyDown(selectedTrace, { key: "E" });
    expect(details.every((block) => block.open)).toBe(true);

    fireEvent.keyDown(selectedTrace, { key: "C" });
    expect(details.every((block) => !block.open)).toBe(true);
  });

  it("shows a compact args preview on tool call summaries", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [
          {
            part_kind: "tool-call",
            tool_name: "read_file",
            args: '{"path": "src/app.py"}',
            tool_call_id: "c1",
          },
        ],
      },
    ];
    const { container } = render(<App />);
    const preview = container.querySelector(".tool-group .block-preview");
    expect(preview?.textContent).toBe('path: "src/app.py"');
    // everything starts collapsed; the summary preview carries the skim info
    expect(container.querySelector<HTMLDetailsElement>(".tool-group")?.open).toBe(false);
    // no per-node JSON toggles: args render as plain nodes once expanded
    expect(container.querySelector(".json-tree details")).toBeNull();
  });

  it("renders JSON keys in their source order", () => {
    window.__TRACE_DATA__ =
      '[{"kind":"response","parts":[{"part_kind":"tool-call","tool_name":"ordered",' +
      '"args":{"10":"ten","2":"two","name":"value"},"tool_call_id":"c1"}]}]';
    const { container } = render(<App />);

    const tree = container.querySelector(".json-tree")!;
    const text = tree.textContent ?? "";
    expect(text.indexOf("10")).toBeLessThan(text.indexOf("2"));
    expect(text.indexOf("2")).toBeLessThan(text.indexOf("name"));
  });

  it("shows cache hit rate behind the cached token count", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [{ part_kind: "text", content: "hi" }],
        usage: { input_tokens: 1000, output_tokens: 5, cache_read_tokens: 823 },
        timestamp: "2026-07-01T09:00:00Z",
      },
    ];
    const { container } = render(<App />);
    expect(container.textContent).toContain("(82.3%)");
  });

  it("explains an interrupted message when the trace has no reason", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "request",
        state: "interrupted",
        parts: [{ part_kind: "user-prompt", content: "hello" }],
      },
    ];
    const { getByText } = render(<App />);

    getByText(
      "This request was interrupted before a response was recorded. The trace does not include a reason.",
    );
  });

  it("renders markdown in text parts", () => {
    window.__TRACE_DATA__ = [
      { kind: "response", parts: [{ part_kind: "text", content: "**bold move**" }] },
    ];
    const { container } = render(<App />);
    expect(container.querySelector(".markdown strong")?.textContent).toBe("bold move");
  });

  it("highlights fenced code during markdown rendering", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [{ part_kind: "text", content: "```python\nprint(True)\n```" }],
      },
    ];
    const { container } = render(<App />);

    expect(container.querySelector("code.language-python .hljs-built_in")?.textContent).toBe(
      "print",
    );
  });

  it("renders scalar and one-item sequence user text consistently", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: "same **prompt**" }],
      },
      {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: ["same **prompt**"] }],
      },
    ];

    const { container } = render(<App />);
    const previews = Array.from(container.querySelectorAll(".tone-user .block-preview"));
    expect(previews.map((preview) => preview.textContent)).toEqual([
      "same **prompt**",
      "same **prompt**",
    ]);
    expect(container.querySelectorAll(".tone-user .markdown strong")).toHaveLength(2);
  });

  it("renders TextContent objects in heterogeneous user content", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "request",
        parts: [
          {
            part_kind: "user-prompt",
            content: [
              { kind: "text", text: "object **text**" },
              { kind: "cache-point" },
              { kind: "future-content", value: 42 },
            ],
          },
        ],
      },
    ];

    const { container, getAllByText } = render(<App />);
    expect(container.querySelector(".tone-user .markdown strong")?.textContent).toBe("text");
    getAllByText("cache point");
    expect(container.querySelector(".tone-user .json-tree")?.textContent).toContain(
      "future-content",
    );
  });

  it("renders an all-JSON text response as a structured value", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [
          {
            part_kind: "text",
            content: '{"status":"ok","items":[1,2]}',
          },
        ],
      },
    ];
    const { container } = render(<App />);

    expect(container.querySelector(".json-tree")).not.toBeNull();
    expect(container.querySelector(".markdown")).toBeNull();
    expect(container.querySelector(".raw-text")).toBeNull();
    expect(container.textContent).toContain('status: "ok"');
    expect(container.textContent).not.toContain('{"status":"ok","items":[1,2]}');
  });

  it("escapes JSON string primitives", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [
          {
            part_kind: "tool-return",
            tool_name: "echo",
            content: { value: 'line 1\n"line 2"' },
          },
        ],
      },
    ];
    const { container } = render(<App />);

    expect(container.querySelector(".json-string")?.textContent).toBe('"line 1\\n\\"line 2\\""');
  });

  it("measures large JSON strings in UTF-8 bytes", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [
          {
            part_kind: "tool-return",
            tool_name: "echo",
            content: { value: "é".repeat(6_000) },
          },
        ],
      },
    ];
    const { container } = render(<App />);

    expect(container.querySelector(".json-tree details.collapsible")?.textContent).toContain(
      "11.7 KB",
    );
  });

  it("keeps prose containing a JSON fragment as markdown", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "response",
        parts: [{ part_kind: "text", content: 'Result: {"status":"ok"}' }],
      },
    ];
    const { container } = render(<App />);

    expect(container.querySelector(".markdown")).not.toBeNull();
    expect(container.querySelector(".json-tree")).toBeNull();
  });

  it("renders an empty trace without crashing", () => {
    window.__TRACE_DATA__ = [];
    render(<App />);
  });

  it("falls back to a linked chip when an image attachment fails to load", () => {
    window.__TRACE_DATA__ = [
      {
        kind: "request",
        parts: [
          {
            part_kind: "user-prompt",
            content: [{ kind: "image-url", url: "https://example.com/x.png" }],
          },
        ],
      },
    ];
    const { container } = render(<App />);
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    const chip = container.querySelector(".media-chip")!;
    expect(chip.textContent).toContain("https://example.com/x.png");
    expect(chip.closest("a")?.getAttribute("href")).toBe("https://example.com/x.png");
  });
});
