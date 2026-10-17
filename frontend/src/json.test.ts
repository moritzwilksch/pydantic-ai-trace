import { describe, expect, it } from "vitest";
import { jsonEntries, parseJson, stringifyJson } from "./json";

describe("parseJson", () => {
  it("keeps integer-like keys in source order at every depth", () => {
    const text = '{"b":{"10":"ten","2":"two"},"1":[{"9":null,"a":true}]}';

    const value = parseJson(text) as Record<string, unknown>;

    expect(jsonEntries(value).map(([key]) => key)).toEqual(["b", "1"]);
    expect(stringifyJson(value)).toBe(text);
  });

  it("does not mistake escaped quotes and colons in values for keys", () => {
    const text = String.raw`{"2":"say \"3\": no","1":"\\","0" : "x\\\":y"}`;

    const value = parseJson(text) as Record<string, unknown>;

    expect(jsonEntries(value)).toEqual([
      ["2", 'say "3": no'],
      ["1", "\\"],
      ["0", 'x\\":y'],
    ]);
  });

  it("parses a value holding many escaped quotes in linear time", () => {
    // The former quadratic key scan took over 40 s for this input; a linear one takes milliseconds.
    const transcript = '{"id":1}\n'.repeat(50_000);
    const text = `{"2":${JSON.stringify(transcript)},"1":"end"}`;

    const started = performance.now();
    const value = parseJson(text) as Record<string, unknown>;
    const elapsed = performance.now() - started;

    expect(jsonEntries(value)).toEqual([
      ["2", transcript],
      ["1", "end"],
    ]);
    expect(elapsed).toBeLessThan(1000);
  });
});
