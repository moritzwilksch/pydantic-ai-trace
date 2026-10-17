import { ChevronDown, ChevronUp, Search, X } from "lucide-preact";
import { createContext, type ComponentChildren, type RefObject } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { focusTraceTarget } from "./KeyboardNav";

const MATCH_HIGHLIGHT = "trace-search-match";
const CURRENT_HIGHLIGHT = "trace-search-current";

export interface TraceSearchProps {
  rootRef: RefObject<HTMLElement>;
}

interface TraceMatch {
  range: Range;
  segments: Range[];
  anchor: HTMLElement;
}

/**
 * The current match and how to reveal it. A new query scrolls to its first match
 * while typing continues; Enter and the arrows also move focus to the match. A
 * re-render of the trace keeps the current match without scrolling.
 */
interface ActiveMatch {
  index: number;
  reveal: "none" | "scroll" | "focus";
}

const NO_MATCH: ActiveMatch = { index: -1, reveal: "none" };

interface SearchQuery {
  query: string;
  setQuery: (query: string) => void;
}

const SearchQueryContext = createContext<SearchQuery | null>(null);

/**
 * Shares the search query between the search box and the trace, so content that holds
 * text back, like paginated JSON, can render what the query matches. Children that do
 * not read the query skip re-rendering as it changes. A new `resetKey` clears the query.
 */
export function TraceSearchScope({
  resetKey,
  children,
}: {
  resetKey: string;
  children: ComponentChildren;
}) {
  const [state, setState] = useState({ key: resetKey, query: "" });
  const query = state.key === resetKey ? state.query : "";
  const value = useMemo(
    () => ({ query, setQuery: (next: string) => setState({ key: resetKey, query: next }) }),
    [query, resetKey],
  );
  return <SearchQueryContext.Provider value={value}>{children}</SearchQueryContext.Provider>;
}

/** The active search query, or "" outside a TraceSearchScope. */
export function useSearchQuery(): string {
  return useContext(SearchQueryContext)?.query ?? "";
}

/** Matches `query` the way the search box does: literally and case-insensitively. */
export function searchPattern(query: string): RegExp {
  return new RegExp(escapeRegExp(query), "giu");
}

/** Search the rendered trace without coupling search to message wire types. */
export function TraceSearch({ rootRef }: TraceSearchProps) {
  const scope = useContext(SearchQueryContext);
  if (!scope) throw new Error("TraceSearch must be rendered inside a TraceSearchScope");
  const { query, setQuery } = scope;
  const [matches, setMatches] = useState<TraceMatch[]>([]);
  const [active, setActive] = useState<ActiveMatch>(NO_MATCH);
  const observerRef = useRef<MutationObserver | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const searchRoot: HTMLElement = root;

    function refresh(queryChanged: boolean) {
      const next = query ? findTextMatches(searchRoot, query) : [];
      setMatches(next);
      setActive((current) => {
        if (next.length === 0) return NO_MATCH;
        if (queryChanged) return { index: 0, reveal: "scroll" };
        return { index: Math.min(Math.max(current.index, 0), next.length - 1), reveal: "none" };
      });
    }

    refresh(true);
    const observer = new MutationObserver(() => refresh(false));
    observerRef.current = observer;
    observer.observe(searchRoot, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [query, rootRef]);

  useEffect(() => {
    const observer = observerRef.current;
    const root = rootRef.current;
    observer?.disconnect();
    publishHighlights(matches, active.index);
    const match = matches[active.index];
    if (match && active.reveal !== "none") revealMatch(match, root, active.reveal === "focus");
    if (observer && root) {
      observer.observe(root, { childList: true, characterData: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      clearHighlights();
    };
  }, [active, matches, rootRef]);

  function move(delta: number) {
    if (matches.length === 0) return;
    setActive(({ index }) => ({
      index: (index + delta + matches.length) % matches.length,
      reveal: "focus",
    }));
  }

  function clear(input: HTMLInputElement) {
    setQuery("");
    input.blur();
  }

  const result = matches.length > 0 ? `${active.index + 1} / ${matches.length}` : "0 / 0";
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
            // Like a browser find bar: leave the search, keep the query and its matches.
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {query ? (
        <>
          <span class="trace-search-count" aria-live="polite">
            {result}
          </span>
          <button
            data-trace-search-previous
            type="button"
            aria-label="Previous search match"
            title="Previous match (Shift+Enter)"
            disabled={matches.length === 0}
            onClick={() => move(-1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            data-trace-search-next
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
            title="Clear search"
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
  const expression = searchPattern(query);
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
      if (anchor) {
        const first = segments.indexOf(startSegment);
        const last = segments.indexOf(endSegment);
        const highlightSegments = segments
          .slice(first, last + 1)
          .map((segment, index, selected) => {
            const part = document.createRange();
            part.setStart(segment.node, index === 0 ? start - segment.start : 0);
            part.setEnd(
              segment.node,
              index === selected.length - 1 ? end - segment.start : segment.node.data.length,
            );
            return part;
          });
        matches.push({ range, segments: highlightSegments, anchor });
      }
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
  if (matches.length === 0) return;
  if (supportsHighlights()) {
    const all = new Highlight(...matches.map(({ range }) => range));
    all.priority = 0;
    CSS.highlights.set(MATCH_HIGHLIGHT, all);
    const active = matches[activeIndex];
    if (active) {
      const current = new Highlight(active.range);
      current.priority = 1;
      CSS.highlights.set(CURRENT_HIGHLIGHT, current);
    }
    return;
  }
  for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex -= 1) {
    const match = matches[matchIndex];
    for (const segment of [...match.segments].reverse()) {
      const mark = document.createElement("mark");
      mark.className = `trace-search-mark${matchIndex === activeIndex ? " current" : ""}`;
      mark.dataset.traceSearchMark = "";
      segment.surroundContents(mark);
    }
  }
}

function clearHighlights(): void {
  if (supportsHighlights()) {
    CSS.highlights.delete(MATCH_HIGHLIGHT);
    CSS.highlights.delete(CURRENT_HIGHLIGHT);
  }
  for (const mark of document.querySelectorAll<HTMLElement>("[data-trace-search-mark]")) {
    mark.replaceWith(...mark.childNodes);
  }
}

function supportsHighlights(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function revealMatch(match: TraceMatch, root: HTMLElement | null, focus: boolean): void {
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
  const container = match.anchor.closest<HTMLElement>("[data-nav]");
  if (container) {
    if (focus) {
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    }
    focusTraceTarget(container);
  }
  match.anchor.scrollIntoView?.({ block: "center" });
}
