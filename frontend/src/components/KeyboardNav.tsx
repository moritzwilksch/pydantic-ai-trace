// Vim-style keyboard navigation over the rendered trace:
// j/k walk parts, n/p jump messages (focusing the whole card), h/l switch
// panes, o/Enter toggles the focused block (or all blocks of a focused card),
// e/c expand/collapse a message, and E/C expand/collapse the full trace.
//
// Navigation works directly on the DOM (elements marked with data-nav /
// data-card) instead of lifted state: the focused element gets a `kb-focus`
// class and native <details> elements are toggled in place. Every toggle is
// wrapped in `withStableView` so the content the user is looking at never
// jumps when heights above it change.

import { useEffect, useState } from "preact/hooks";

const FOCUS_CLASS = "kb-focus";

function navTargets(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".trace-body [data-nav]"));
}

function cardTargets(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".trace-body [data-card]"));
}

function focusedTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.trace-body .${FOCUS_CLASS}`);
}

function setFocus(element: HTMLElement | undefined, scrollBlock: ScrollLogicalPosition): void {
  focusedTarget()?.classList.remove(FOCUS_CLASS);
  if (!element) return;
  element.classList.add(FOCUS_CLASS);
  element.scrollIntoView({ block: scrollBlock });
}

function moveFocus(delta: number): void {
  const targets = navTargets();
  if (targets.length === 0) return;
  const focused = focusedTarget();
  let next: number;
  if (focused?.hasAttribute("data-card")) {
    // Descend from a focused card into its parts: j enters the card,
    // k moves to the part just before it.
    const firstInside = targets.findIndex((el) => focused.contains(el));
    next = firstInside === -1 ? 0 : delta > 0 ? firstInside : firstInside - 1;
  } else {
    const current = focused ? targets.indexOf(focused) : -1;
    next = current === -1 ? (delta > 0 ? 0 : targets.length - 1) : current + delta;
  }
  setFocus(targets[Math.max(0, Math.min(targets.length - 1, next))], "nearest");
}

function moveCard(delta: number): void {
  const cards = cardTargets();
  if (cards.length === 0) return;
  const focused = focusedTarget();
  const currentCard = focused?.closest<HTMLElement>("[data-card]") ?? null;
  const current = currentCard ? cards.indexOf(currentCard) : -1;
  let next: number;
  if (current !== -1) next = current + delta;
  // Nothing focused: n/p start from the respective end, but gg/G (±Infinity)
  // must still land on the extreme the jump names.
  else if (Number.isFinite(delta)) next = delta > 0 ? 0 : cards.length - 1;
  else next = delta > 0 ? cards.length - 1 : 0;
  setFocus(cards[Math.max(0, Math.min(cards.length - 1, next))], "start");
}

/**
 * Run a layout-changing mutation while keeping `anchor` at the same viewport
 * position, so expanding/collapsing never visually jumps the view.
 */
function withStableView(anchor: HTMLElement | null, mutate: () => void): void {
  const container = document.querySelector<HTMLElement>(".trace-body");
  if (!anchor || !container) {
    mutate();
    return;
  }
  const before = anchor.getBoundingClientRect().top;
  mutate();
  container.scrollTop += anchor.getBoundingClientRect().top - before;
}

/** The first card still (partly) visible — the natural anchor when nothing is focused. */
function topVisibleCard(): HTMLElement | null {
  const container = document.querySelector<HTMLElement>(".trace-body");
  if (!container) return null;
  const containerTop = container.getBoundingClientRect().top;
  return cardTargets().find((card) => card.getBoundingClientRect().bottom > containerTop) ?? null;
}

function focusedDetails(focused: HTMLElement): HTMLDetailsElement[] {
  if (focused.hasAttribute("data-card")) {
    return Array.from(focused.querySelectorAll("details"));
  }
  const details =
    focused instanceof HTMLDetailsElement ? focused : focused.querySelector("details");
  return details ? [details] : [];
}

function toggleFocused(): void {
  const focused = focusedTarget();
  if (!focused) return;
  withStableView(focused, () => {
    // For a focused card: open everything inside, or close all if all open.
    const all = focusedDetails(focused);
    const anyClosed = all.some((details) => !details.open);
    for (const details of all) details.open = anyClosed;
  });
}

/** Expand/collapse the focused block; returns true if anything changed. */
function setFocusedOpen(open: boolean): boolean {
  const focused = focusedTarget();
  if (!focused) return false;
  let changed = false;
  withStableView(focused, () => {
    for (const details of focusedDetails(focused)) {
      if (details.open !== open) {
        details.open = open;
        changed = true;
      }
    }
  });
  return changed;
}

/** Expand/collapse every block within the current message card only. */
function setAllInCard(open: boolean): void {
  const focused = focusedTarget();
  const card = focused?.closest<HTMLElement>("[data-card]") ?? topVisibleCard();
  if (!card) return;
  withStableView(focused ?? card, () => {
    for (const details of card.querySelectorAll("details")) {
      details.open = open;
    }
  });
}

/** Expand/collapse every content block in the main trace view. */
function setAllInTrace(open: boolean): void {
  const focused = focusedTarget();
  const anchor = focused ?? topVisibleCard();
  withStableView(anchor, () => {
    for (const details of document.querySelectorAll<HTMLDetailsElement>(".trace-body details")) {
      details.open = open;
    }
  });
}

function focusTreePane(): void {
  const tree = document.querySelector<HTMLElement>(".tree-pane");
  if (!tree) return;
  const target =
    tree.querySelector<HTMLElement>("button.selected") ??
    tree.querySelector<HTMLElement>("button:not([disabled])");
  target?.focus();
}

function moveTreeFocus(delta: number): void {
  const buttons = Array.from(
    document.querySelectorAll<HTMLElement>(".tree-pane button:not([disabled])"),
  );
  if (buttons.length === 0) return;
  const current = buttons.indexOf(document.activeElement as HTMLElement);
  const next = current === -1 ? 0 : Math.max(0, Math.min(buttons.length - 1, current + delta));
  buttons[next].focus();
  buttons[next].scrollIntoView({ block: "nearest" });
}

/** Open the focused trace without focusing stale main-pane content while it loads. */
function openFocusedTreeTrace(): void {
  const active = document.activeElement as HTMLElement | null;
  active?.click();
  active?.blur();
}

/** Move from a jsonl trace entry back to its containing file, when present. */
function focusTreeParent(): void {
  const active = document.activeElement as HTMLElement | null;
  const parent = active?.closest<HTMLElement>(".tree-children")?.previousElementSibling;
  if (parent instanceof HTMLButtonElement && !parent.disabled) parent.focus();
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")
  );
}

function focusTraceSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>("[data-trace-search]");
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

export function useKeyboardNav(): { helpOpen: boolean; closeHelp: () => void } {
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let previousKey = "";
    function onKeyDown(event: KeyboardEvent) {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const inTree = (event.target as HTMLElement | null)?.closest?.(".tree-pane") != null;
      const key = event.key;
      const moveLeft = key === "h" || key === "ArrowLeft";
      const moveRight = key === "l" || key === "ArrowRight";
      const moveDown = key === "j" || key === "ArrowDown";
      const moveUp = key === "k" || key === "ArrowUp";
      let handled = true;

      if (key === "?") setHelpOpen((open) => !open);
      else if (key === "Escape") setHelpOpen(false);
      else if (key === "/") handled = focusTraceSearch();
      // Trace-wide actions work from either pane. In server mode, focus stays
      // on the selected tree button after a trace opens.
      else if (key === "E") setAllInTrace(true);
      else if (key === "C") setAllInTrace(false);
      // vim-fold semantics: h closes the focused block first; once there is
      // nothing left to close, a second h moves over to the file tree.
      else if (moveLeft && !inTree) {
        if (!setFocusedOpen(false)) focusTreePane();
      }
      // Mirror of h: l in the tree opens the selected trace. Do not focus a
      // main-pane block here: the current trace can still be mounted while
      // the newly selected one is loading, causing a brief stale focus ring.
      else if (moveRight && inTree) {
        openFocusedTreeTrace();
      } else if (moveLeft && inTree) focusTreeParent();
      else if (moveRight) setFocusedOpen(true);
      else if (moveDown) (inTree ? moveTreeFocus : moveFocus)(1);
      else if (moveUp) (inTree ? moveTreeFocus : moveFocus)(-1);
      else if (key === "Home" && inTree) moveTreeFocus(Number.NEGATIVE_INFINITY);
      else if (key === "End" && inTree) moveTreeFocus(Number.POSITIVE_INFINITY);
      else if (key === "n" && !inTree) moveCard(1);
      else if (key === "p" && !inTree) moveCard(-1);
      else if ((key === "o" || key === "Enter") && !inTree) toggleFocused();
      else if (key === "e" && !inTree) setAllInCard(true);
      else if (key === "c" && !inTree) setAllInCard(false);
      else if (key === "G" && !inTree) moveCard(Number.POSITIVE_INFINITY);
      else if (key === "g" && previousKey === "g" && !inTree) moveCard(Number.NEGATIVE_INFINITY);
      else handled = key === "g"; // first g of a gg chord

      previousKey = previousKey === "g" && key === "g" ? "" : key;
      if (handled) event.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return { helpOpen, closeHelp: () => setHelpOpen(false) };
}

const KEY_HELP: [string, string][] = [
  ["/", "search within the trace"],
  ["j / k · ↑ / ↓", "next / previous block (or trace in the file tree)"],
  ["h / l · ← / →", "collapse / expand block (tree: parent / open trace)"],
  ["n / p", "next / previous message"],
  ["o / Enter", "toggle focused block (or whole message)"],
  ["e / c", "expand / collapse all blocks in the message"],
  ["E / C", "expand / collapse all blocks in the trace"],
  ["gg / G", "first / last message"],
  ["?", "toggle this help"],
];

export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div class="help-overlay" onClick={onClose}>
      <div class="help-panel" onClick={(e) => e.stopPropagation()}>
        <div class="help-title">Keyboard shortcuts</div>
        <table>
          <tbody>
            {KEY_HELP.map(([keys, description]) => (
              <tr key={keys}>
                <td>
                  <kbd>{keys}</kbd>
                </td>
                <td>{description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
