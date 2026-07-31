import type { ComponentChildren } from "preact";
import { jsonEntries } from "../json";

const LARGE_STRING_BYTES = 10_000;

/**
 * Plain, fully-expanded JSON rendering — no per-node show/hide toggles. The
 * surrounding block already collapses and height-clamps, so once a block is
 * open its data is simply all there.
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
        {entries.map(([key, child]) => (
          <JsonNode key={key} label={key} value={child} />
        ))}
      </div>
    </div>
  );
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (value.length > LARGE_STRING_BYTES) {
      return (
        <CollapsedPayload sizeLabel={formatBytes(value.length)}>
          <span class="json-string">"{value}"</span>
        </CollapsedPayload>
      );
    }
    return <span class="json-string">"{value}"</span>;
  }
  if (typeof value === "number") return <span class="json-num">{String(value)}</span>;
  if (typeof value === "boolean") return <span class="json-bool">{String(value)}</span>;
  return <span class="json-null">null</span>;
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

export const LARGE_PAYLOAD_BYTES = LARGE_STRING_BYTES;
