import { act, cleanup } from "@testing-library/preact";

/**
 * Unmounts every rendered tree and runs the effect cleanups that unmounting
 * leaves queued.
 *
 * Preact queues the passive-effect cleanups of unmounted components in
 * `unmountCleanups` and flushes them through `afterPaint` after about 35ms. A
 * bare `cleanup()` can therefore leave them pending when the test file ends, and
 * they then run against a torn-down jsdom (`window is not defined`). Running
 * `cleanup()` inside `act` flushes them first.
 */
export async function unmountAll(): Promise<void> {
  await act(async () => cleanup());
}
