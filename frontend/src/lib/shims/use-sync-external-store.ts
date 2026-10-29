// Stands in for `use-sync-external-store/shim` and `/shim/with-selector`; see the
// alias in vite.config.ts.
export { useSyncExternalStore } from "preact/compat";

export function useSyncExternalStoreWithSelector(): never {
  throw new Error(
    "useSyncExternalStoreWithSelector is unimplemented: Base UI calls it only on React < 19, " +
      "and preact/compat reports React 19. A Preact or Base UI update broke that assumption.",
  );
}
