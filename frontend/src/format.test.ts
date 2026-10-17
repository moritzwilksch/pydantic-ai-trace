import { describe, expect, it } from "vitest";
import {
  cacheHitRate,
  compactJson,
  formatCost,
  formatCount,
  formatDuration,
  formatTotalsCost,
  markdownPreview,
  parseJsonContainer,
} from "./format";
import { parseJson } from "./json";

describe("parseJsonContainer", () => {
  it("parses complete JSON objects and arrays", () => {
    expect(parseJsonContainer('  {"status": "ok"}\n')).toEqual({ status: "ok" });
    expect(parseJsonContainer("[1, 2]")).toEqual([1, 2]);
  });

  it("ignores prose, fragments, and scalar JSON", () => {
    expect(parseJsonContainer('Result: {"status": "ok"}')).toBeNull();
    expect(parseJsonContainer('{"status": "ok"} trailing')).toBeNull();
    expect(parseJsonContainer("true")).toBeNull();
  });
});

describe("compactJson", () => {
  it("renders objects as key: value pairs", () => {
    expect(compactJson({ path: "src/app.py", limit: 5 })).toBe('path: "src/app.py", limit: 5');
  });

  it("keeps integer-like keys in JSON source order", () => {
    const args = parseJson('{"10":"ten","2":"two","name":"value"}');

    expect(compactJson(args)).toBe('10: "ten", 2: "two", name: "value"');
  });

  it("renders nested arrays and null", () => {
    expect(compactJson({ ids: [1, 2], next: null })).toBe("ids: [1, 2], next: null");
  });

  it("truncates long output with an ellipsis", () => {
    const long = compactJson({ text: "x".repeat(500) }, 40);
    expect(long.length).toBe(40);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("cacheHitRate", () => {
  it("is null when nothing was cached", () => {
    expect(cacheHitRate(1000, 0)).toBeNull();
  });

  it("uses input tokens as denominator when cache reads are included (OpenAI style)", () => {
    expect(cacheHitRate(1000, 823)).toBeCloseTo(82.3);
  });

  it("adds exclusive cache reads to the denominator (Anthropic style)", () => {
    expect(cacheHitRate(100, 900)).toBeCloseTo(90.0);
  });
});

describe("formatCost", () => {
  it("shows four decimals of the exact decimal string", () => {
    expect(formatCost("0.0028125")).toBe("$0.0028");
    expect(formatCost("12")).toBe("$12.0000");
  });
});

describe("formatTotalsCost", () => {
  const totals = (cost_usd: string | null, unpriced_calls: number) => ({
    llm_calls: 2,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost_usd,
    unpriced_calls,
    duration_seconds: 0,
  });

  it("marks a partial cost and an unknown one", () => {
    expect(formatTotalsCost(totals("0.01", 0))).toBe("$0.0100");
    expect(formatTotalsCost(totals("0.01", 1))).toBe("$0.0100 (+1 unpriced)");
    expect(formatTotalsCost(totals(null, 2))).toBe("cost unknown");
    expect(formatTotalsCost(totals(null, 0))).toBeNull();
  });
});

describe("formatCount", () => {
  it("groups digits below 10,000 and abbreviates above", () => {
    expect([999, 1000, 9999, 10_000, 20_459_704].map(formatCount)).toEqual([
      "999",
      "1,000",
      "9,999",
      "10.0k",
      "20.46M",
    ]);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0.0s"],
    [59.94, "59.9s"],
    [59.96, "1m 0s"],
    [863.2, "14m 23s"],
    [7325.6, "2h 2m 6s"],
  ])("formats %s seconds as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe("markdownPreview", () => {
  it("strips inline and block markdown syntax", () => {
    expect(markdownPreview("# Title\n\n- **bold** and *em* and ~~gone~~\n> `code`")).toBe(
      "Title bold and em and gone code",
    );
    expect(markdownPreview("![chart](a.png) [link](https://x.test)")).toBe("chart link");
    expect(markdownPreview("```python\nprint(1)\n```")).toBe("print(1)");
  });

  it("keeps underscores and asterisks that are not emphasis", () => {
    expect(markdownPreview("call snake_case_name with 2 * 3 * 4")).toBe(
      "call snake_case_name with 2 * 3 * 4",
    );
  });

  it("truncates long text without scanning all of it", () => {
    const preview = markdownPreview(`**${"a".repeat(1_000)}**`, 20);
    expect(preview).toBe(`${"a".repeat(19)}…`);
  });
});
