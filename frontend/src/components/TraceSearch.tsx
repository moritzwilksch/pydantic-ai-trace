import { ChevronDown, ChevronUp, Search, X } from "lucide-preact";
import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";

const MATCH_HIGHLIGHT = "trace-search-match";
const CURRENT_HIGHLIGHT = "trace-search-current";

export interface TraceSearchProps {
  rootRef: RefObject<HTMLElement>;
}

interface TraceMatch {
  range: Range;
  anchor: HTMLElement;
}

/** Search the rendered trace without coupling search to message wire types. */
export function TraceSearch({ rootRef }: TraceSearchProps) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<TraceMatch[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const searchRoot: HTMLElement = root;

    function refresh() {
      const next = query ? findTextMatches(searchRoot, query) : [];
      setMatches(next);
      setActiveIndex(next.length > 0 ? 0 : -1);
    }

    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(searchRoot, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [query, rootRef]);

  useEffect(() => {
    publishHighlights(matches, activeIndex);
    const active = matches[activeIndex];
    if (active) revealMatch(active, rootRef.current);
    return clearHighlights;
  }, [activeIndex, matches, rootRef]);

  function move(delta: number) {
    if (matches.length === 0) return;
    setActiveIndex((current) => (current + delta + matches.length) % matches.length);
  }

  function clear(input: HTMLInputElement) {
    setQuery("");
    input.blur();
  }

  const result = matches.length > 0 ? `${activeIndex + 1} / ${matches.length}` : "0 / 0";
  return (
    <div class="trace-search">
      <Search class="trace-search-icon" size={14} aria-hidden="true" />
      <input
        data-trace-search
        type="search"
        aria-label="Search trace"
        placeholder="Search trace…"
        value={query}
        onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            clear(event.currentTarget);
          }
        }}
      />
      {query ? (
        <>
          <span class="trace-search-count" aria-live="polite">
            {result}
          </span>
          <button
            type="button"
            aria-label="Previous search match"
            title="Previous match (Shift+Enter)"
            disabled={matches.length === 0}
            onClick={() => move(-1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            aria-label="Next search match"
            title="Next match (Enter)"
            disabled={matches.length === 0}
            onClick={() => move(1)}
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            aria-label="Clear trace search"
            title="Clear search (Escape)"
            onClick={(event) => clear(event.currentTarget.parentElement!.querySelector("input")!)}
          >
            <X size={13} />
          </button>
        </>
      ) : (
        <kbd>/</kbd>
      )}
    </div>
  );
}

function findTextMatches(root: HTMLElement, query: string): TraceMatch[] {
  const expression = new RegExp(escapeRegExp(query), "giu");
  const matches: TraceMatch[] = [];
  for (const unit of searchUnits(root)) {
    const segments = textSegments(unit);
    const text = segments.map(({ node }) => node.data).join("");
    for (const result of text.matchAll(expression)) {
      const start = result.index;
      const end = start + result[0].length;
      const startSegment = segments.find((segment) => start < segment.end);
      const endSegment = segments.find((segment) => end <= segment.end);
      if (!startSegment || !endSegment) continue;
      const range = document.createRange();
      range.setStart(startSegment.node, start - startSegment.start);
      range.setEnd(endSegment.node, end - endSegment.start);
      const anchor = startSegment.node.parentElement;
      if (anchor) matches.push({ range, anchor });
    }
  }
  return matches;
}

function searchUnits(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(".part, .card-kind, .card-footer, .interrupted-message"),
  ).filter((unit) => !unit.parentElement?.closest(".part"));
}

function textSegments(unit: HTMLElement): { node: Text; start: number; end: number }[] {
  const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !node.textContent ||
        !parent ||
        parent.closest(".block-preview, button, [data-search-ignore]")
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const segments: { node: Text; start: number; end: number }[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    segments.push({ node: text, start: offset, end: offset + text.data.length });
    offset += text.data.length;
  }
  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function publishHighlights(matches: TraceMatch[], activeIndex: number): void {
  clearHighlights();
  if (!supportsHighlights() || matches.length === 0) return;
  const all = new Highlight(...matches.map(({ range }) => range));
  all.priority = 0;
  CSS.highlights.set(MATCH_HIGHLIGHT, all);
  const active = matches[activeIndex];
  if (active) {
    const current = new Highlight(active.range);
    current.priority = 1;
    CSS.highlights.set(CURRENT_HIGHLIGHT, current);
  }
}

function clearHighlights(): void {
  if (!supportsHighlights()) return;
  CSS.highlights.delete(MATCH_HIGHLIGHT);
  CSS.highlights.delete(CURRENT_HIGHLIGHT);
}

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function revealMatch(match: TraceMatch, root: HTMLElement | null): void {
  if (!root) return;
  const ancestors: HTMLDetailsElement[] = [];
  let current: HTMLElement | null = match.anchor;
  while (current && root.contains(current)) {
    const details: HTMLDetailsElement | null = current.closest("details");
    if (!details || !root.contains(details)) break;
    ancestors.push(details);
    current = details.parentElement;
  }
  for (const details of ancestors.reverse()) details.open = true;
  match.anchor.scrollIntoView?.({ block: "center" });
}
