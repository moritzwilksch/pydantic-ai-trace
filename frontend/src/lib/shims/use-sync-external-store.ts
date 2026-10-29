// Stands in for `use-sync-external-store/shim`, which Base UI imports. The real
// shim is CommonJS and requires React itself; see the aliases in vite.config.ts.
export { useSyncExternalStore } from "preact/compat";
