/** localStorage can be entirely absent or throw on access (sandboxed iframe). */
export function storage<T>(use: (s: Storage) => T): T | null {
  try {
    return use(globalThis.localStorage);
  } catch {
    return null;
  }
}
