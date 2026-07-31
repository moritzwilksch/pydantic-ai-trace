/**
 * JSON objects remember their key order separately because JavaScript always
 * enumerates integer-like keys first, regardless of their position in the
 * source text.
 */
const sourceKeyOrder = new WeakMap<object, readonly string[]>();
const KEY_PREFIX = "\0";
const JSON_KEY = /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/g;

export function parseJson(text: string): unknown {
  // In valid JSON a string token followed by ":" can only be an object key.
  // Prefixing those tokens prevents JSON.parse from reordering numeric keys.
  const prefixed = text.replace(JSON_KEY, (key) => `"\\u0000${key.slice(1)}`);
  return restoreKeys(JSON.parse(prefixed) as unknown);
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
