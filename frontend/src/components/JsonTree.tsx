import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { jsonEntries } from "../json";

const LARGE_STRING_BYTES = 10_000;
/** Entries an array or object shows before a "show more" button; keeps huge tool results cheap. */
export const JSON_PAGE_SIZE = 100;

/**
 * Plain, expanded JSON rendering — no per-node show/hide toggles. The
 * surrounding block already collapses and height-clamps; only containers
 * with more than JSON_PAGE_SIZE entries hold back the rest behind a button.
 */
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div class="json-tree">
      <JsonNode value={value} />
    </div>
  );
}

function JsonNode({ value, label }: { value: unknown; label?: string }) {
  const prefix = label !== undefined && (
    <>
      <span class="json-key">{label}</span>
      <span class="json-punct">: </span>
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

  const entries = Array.isArray(value)
    ? value.map((item, i) => [String(i), item] as const)
    : jsonEntries(value);
  if (entries.length === 0) {
    return (
      <div>
        {prefix}
        <span class="json-punct">{Array.isArray(value) ? "[]" : "{}"}</span>
      </div>
    );
  }
  return (
    <div>
      {prefix ? <div>{prefix}</div> : null}
      <div class={label !== undefined ? "json-children" : undefined}>
        <JsonEntries entries={entries} />
      </div>
    </div>
  );
}

function JsonEntries({ entries }: { entries: readonly (readonly [string, unknown])[] }) {
  const [shown, setShown] = useState(JSON_PAGE_SIZE);
  const hidden = entries.length - shown;
  return (
    <>
      {entries.slice(0, shown).map(([key, child]) => (
        <JsonNode key={key} label={key} value={child} />
      ))}
      {hidden > 0 ? (
        <button type="button" class="json-more" onClick={() => setShown(entries.length)}>
          show {hidden} more
        </button>
      ) : null}
    </>
  );
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    const size = byteLength(value);
    const rendered = <JsonString value={value} />;
    if (size > LARGE_STRING_BYTES) {
      return <CollapsedPayload sizeLabel={formatBytes(size)}>{rendered}</CollapsedPayload>;
    }
    return rendered;
  }
  if (typeof value === "number") return <span class="json-num">{String(value)}</span>;
  if (typeof value === "boolean") return <span class="json-bool">{String(value)}</span>;
  return <span class="json-null">null</span>;
}

/**
 * A one-line string stays a quoted JSON literal; a multi-line string is shown verbatim as a
 * block below its key, so code, diffs, and prose keep their line breaks.
 */
function JsonString({ value }: { value: string }) {
  if (value.includes("\n")) return <div class="json-string json-block">{value}</div>;
  return <span class="json-string">{JSON.stringify(value)}</span>;
}

/** Inline-collapsed wrapper for payloads too large to render eagerly. */
export function CollapsedPayload({
  sizeLabel,
  children,
}: {
  sizeLabel: string;
  children: ComponentChildren;
}) {
  return (
    <details class="collapsible">
      <summary>
        <span class="badge">{sizeLabel}</span> click to expand
      </summary>
      {children}
    </details>
  );
}

export function formatBytes(length: number): string {
  if (length < 1024) return `${length} B`;
  if (length < 1024 * 1024) return `${(length / 1024).toFixed(1)} KB`;
  return `${(length / 1024 / 1024).toFixed(1)} MB`;
}

export function byteLength(value: string): number {
  return new Blob([value]).size;
}

export const LARGE_PAYLOAD_BYTES = LARGE_STRING_BYTES;
