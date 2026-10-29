import { useState } from "preact/hooks";
import { jsonEntries } from "../json";
import { Button } from "./ui/button";
import { searchPattern, useSearchQuery } from "./TraceSearch";

/** Entries an array or object shows before a "show more" button; keeps huge tool results cheap. */
export const JSON_PAGE_SIZE = 100;

/**
 * Plain, expanded JSON rendering — no per-node show/hide toggles. The
 * surrounding block already collapses and height-clamps; only containers
 * with more than JSON_PAGE_SIZE entries hold back the rest behind a button.
 * While a trace search is active, they also render the held-back entries it
 * matches, so search can count and reveal them.
 */
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div class="json-tree overflow-x-auto font-mono text-[12.5px]">
      <JsonNode value={value} />
    </div>
  );
}

function JsonNode({ value, label }: { value: unknown; label?: string }) {
  const prefix = label !== undefined && (
    <>
      <span class="text-code-key">{label}</span>
      <span class="text-muted-foreground">: </span>
    </>
  );

  if (value === null || typeof value !== "object") {
    return (
      <div>
        {prefix}
        <JsonPrimitive value={value} />
      </div>
    );
  }

  const entries = containerEntries(value);
  if (entries.length === 0) {
    return (
      <div>
        {prefix}
        <span class="text-muted-foreground">{Array.isArray(value) ? "[]" : "{}"}</span>
      </div>
    );
  }
  return (
    <div>
      {prefix ? <div>{prefix}</div> : null}
      <div class={label !== undefined ? "ml-4" : undefined}>
        <JsonEntries entries={entries} />
      </div>
    </div>
  );
}

type Entries = readonly (readonly [string, unknown])[];

function containerEntries(value: object): Entries {
  return Array.isArray(value)
    ? value.map((item, i) => [String(i), item] as const)
    : jsonEntries(value);
}

function JsonEntries({ entries }: { entries: Entries }) {
  const [expanded, setExpanded] = useState(JSON_PAGE_SIZE);
  const query = useSearchQuery();
  const shown =
    query && expanded < entries.length
      ? Math.max(expanded, matchedEntryCount(entries, query))
      : expanded;
  const hidden = entries.length - shown;
  return (
    <>
      {entries.slice(0, shown).map(([key, child]) => (
        <JsonNode key={key} label={key} value={child} />
      ))}
      {hidden > 0 ? (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 font-mono text-muted-foreground sm:h-auto"
          onClick={() => setExpanded(entries.length)}
        >
          show {hidden} more
        </Button>
      ) : null}
    </>
  );
}

/** How many leading entries to render so every match of `query` in them is in the DOM. */
function matchedEntryCount(entries: Entries, query: string): number {
  const texts = entries.map(([key, child]) => renderedText(child, key));
  let matchEnd = 0;
  for (const match of texts.join("").matchAll(searchPattern(query))) {
    matchEnd = match.index + match[0].length;
  }
  if (matchEnd === 0) return 0;
  let offset = 0;
  for (const [i, text] of texts.entries()) {
    offset += text.length;
    if (offset >= matchEnd) return i + 1;
  }
  return entries.length;
}

/** The text JsonNode renders for `value` once every entry is shown; search reads it. */
function renderedText(value: unknown, label?: string): string {
  const prefix = label === undefined ? "" : `${label}: `;
  if (value === null || typeof value !== "object") return prefix + primitiveText(value);
  const entries = containerEntries(value);
  if (entries.length === 0) return prefix + (Array.isArray(value) ? "[]" : "{}");
  return prefix + entries.map(([key, child]) => renderedText(child, key)).join("");
}

function primitiveText(value: unknown): string {
  if (typeof value === "string") return value.includes("\n") ? value : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "null";
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") return <JsonString value={value} />;
  if (typeof value === "number") return <span class="text-code-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span class="text-code-keyword">{String(value)}</span>;
  return <span class="text-code-keyword">null</span>;
}

const STRING_CLASS = "json-string break-words whitespace-pre-wrap text-code-string";

/**
 * A one-line string stays a quoted JSON literal; a multi-line string is shown verbatim as a
 * block below its key, so code, diffs, and prose keep their line breaks.
 */
function JsonString({ value }: { value: string }) {
  if (value.includes("\n")) {
    return <div class={`${STRING_CLASS} json-block my-0.5 ml-4 border-l-2 pl-2`}>{value}</div>;
  }
  return <span class={STRING_CLASS}>{JSON.stringify(value)}</span>;
}
