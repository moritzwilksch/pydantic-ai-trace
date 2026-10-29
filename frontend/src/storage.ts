/** localStorage can be entirely absent or throw on access (sandboxed iframe). */
export function storage<T>(access: (s: Storage) => T): T | null {
  try {
    return access(globalThis.localStorage);
  } catch {
    return null;
  }
}
