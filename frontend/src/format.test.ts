import { describe, expect, it } from "vitest";
import { cacheHitRate, compactJson, formatCost, parseJsonContainer } from "./format";
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
