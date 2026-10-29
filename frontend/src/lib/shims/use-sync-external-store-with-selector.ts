// Stands in for `use-sync-external-store/shim/with-selector`, which Base UI uses to
// read its stores. The real shim is CommonJS and requires React itself; see the
// aliases in vite.config.ts. Same contract: re-render only when the selection
// changes, as `isEqual` judges it.
import { useMemo, useSyncExternalStore } from "preact/compat";

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  _getServerSnapshot: (() => Snapshot) | null | undefined,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  const getSelection = useMemo(() => {
    let memoized: { snapshot: Snapshot; selection: Selection } | null = null;
    return () => {
      const snapshot = getSnapshot();
      if (memoized !== null && Object.is(memoized.snapshot, snapshot)) {
        return memoized.selection;
      }
      const selection = selector(snapshot);
      if (memoized !== null && isEqual?.(memoized.selection, selection)) {
        memoized = { snapshot, selection: memoized.selection };
      } else {
        memoized = { snapshot, selection };
      }
      return memoized.selection;
    };
  }, [getSnapshot, selector, isEqual]);
  return useSyncExternalStore(subscribe, getSelection);
}
