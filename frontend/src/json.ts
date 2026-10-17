/**
 * JSON objects remember their key order separately because JavaScript always
 * enumerates integer-like keys first, regardless of their position in the
 * source text.
 */
const sourceKeyOrder = new WeakMap<object, readonly string[]>();
const KEY_PREFIX = "\0";

export function parseJson(text: string): unknown {
  return restoreKeys(JSON.parse(prefixKeys(text)) as unknown);
}

/**
 * Prefixes every object key so JSON.parse cannot reorder integer-like keys.
 * In valid JSON a string token followed by ":" can only be an object key.
 * The scan visits each character once; skipping whole strings keeps escaped
 * quotes inside values from being read as token boundaries.
 */
function prefixKeys(text: string): string {
  const chunks: string[] = [];
  let copied = 0;
  let open = text.indexOf('"');
  while (open !== -1) {
    const close = stringEnd(text, open);
    if (close === -1) break;
    let next = close + 1;
    while (isJsonWhitespace(text.charCodeAt(next))) next++;
    if (text[next] === ":") {
      chunks.push(text.slice(copied, open + 1), "\\u0000");
      copied = open + 1;
    }
    open = text.indexOf('"', close + 1);
  }
  chunks.push(text.slice(copied));
  return chunks.join("");
}

/** Index of the quote closing the string opened at `open`, or -1 if unterminated. */
function stringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") i++;
    else if (char === '"') return i;
  }
  return -1;
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function restoreKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreKeys);
  if (typeof value !== "object" || value === null) return value;

  const restored: Record<string, unknown> = {};
  const keys: string[] = [];
  for (const [prefixedKey, child] of Object.entries(value)) {
    const key = prefixedKey.startsWith(KEY_PREFIX)
      ? prefixedKey.slice(KEY_PREFIX.length)
      : prefixedKey;
    keys.push(key);
    Object.defineProperty(restored, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: restoreKeys(child),
    });
  }
  sourceKeyOrder.set(restored, keys);
  return restored;
}

export function jsonEntries(value: object): [string, unknown][] {
  const keys = sourceKeyOrder.get(value);
  if (keys === undefined) return Object.entries(value);
  const record = value as Record<string, unknown>;
  return keys.map((key) => [key, record[key]]);
}

export function stringifyJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== "object" || child === null || Array.isArray(child)) return child;
    const keys = sourceKeyOrder.get(child);
    return keys === undefined ? child : new Proxy(child, { ownKeys: () => [...keys] });
  });
}
