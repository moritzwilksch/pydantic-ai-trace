import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  embeddedTrace,
  embeddedTraceCollection,
  fetchMeta,
  fetchTrace,
  fetchTree,
  subscribeChanges,
} from "./api";
import { parseTrace } from "./parse";
import { defaultSelection } from "./selection";
import { CopyTraceButton } from "./components/CopyTraceButton";
import { KeyboardHelp, useKeyboardNav } from "./components/KeyboardNav";
import { ThemeToggle } from "./components/ThemeToggle";
import { TraceSearch } from "./components/TraceSearch";
import { TraceStatsBar, TraceView } from "./components/TraceView";
import { TreePane } from "./components/TreePane";
import type {
  EmbeddedTraceCollection,
  Meta,
  TracePayload,
  TraceSelection,
  TreeNode,
} from "./types";

type TraceState =
  | { status: "unselected" }
  | { status: "loading" }
  | { status: "ready"; data: TracePayload }
  | { status: "error"; message: string };

export function App() {
  const collection = useMemo(embeddedTraceCollection, []);
  const embedded = useMemo(embeddedTrace, []);
  const { helpOpen, closeHelp } = useKeyboardNav();
  return (
    <>
      {collection ? (
        <ExportedCollectionApp collection={collection} />
      ) : embedded ? (
        <ExportedTraceApp
          name={embedded.name}
          data={embedded.data}
          transcript={embedded.transcript}
        />
      ) : (
        <ServerApp />
      )}
      {helpOpen ? <KeyboardHelp onClose={closeHelp} /> : null}
    </>
  );
}

/** Exported single-file HTML: no server, trace injected as __TRACE_DATA__. */
function ExportedTraceApp({
  name,
  data,
  transcript,
}: {
  name: string;
  data: unknown;
  transcript: string;
}) {
  return (
    <div class="layout">
      <ExportedTracePane name={name} data={data} transcript={transcript} />
    </div>
  );
}

function ExportedCollectionApp({ collection }: { collection: EmbeddedTraceCollection }) {
  const [selection, setSelection] = useState<TraceSelection>({
    path: collection.traces[0].name,
  });
  // Trace names are the identity here: Python guarantees them non-empty and
  // unique, and the tree pane filters and labels nodes by `path`.
  const tree = useMemo<TreeNode>(
    () => ({
      name: collection.title,
      path: ".",
      type: "dir",
      children: collection.traces.map((trace) => ({
        name: trace.name,
        path: trace.name,
        type: "file",
        format: "json",
        trace_count: 1,
        error: false,
      })),
    }),
    [collection],
  );
  const selected =
    collection.traces.find((trace) => trace.name === selection.path) ?? collection.traces[0];
  return (
    <div class="layout">
      <TreePane
        root={tree}
        rootLabel={collection.title}
        selection={selection}
        onSelect={setSelection}
      />
      <ExportedTracePane
        key={selected.name}
        name={selected.name}
        data={selected.source}
        transcript={selected.transcript}
      />
    </div>
  );
}

function ExportedTracePane({
  name,
  data,
  transcript,
}: {
  name: string;
  data: unknown;
  transcript: string;
}) {
  const messages = useMemo(() => parseTrace(data), [data]);
  const traceRootRef = useRef<HTMLDivElement>(null);
  return (
    <main class="main-pane">
      <header class="trace-header">
        <span class="trace-title">{name}</span>
        <TraceStatsBar messages={messages} />
        {messages.length > 0 ? <TraceSearch rootRef={traceRootRef} /> : null}
        <CopyTraceButton text={transcript} />
        <ThemeToggle />
      </header>
      <div class="trace-body">
        <div ref={traceRootRef}>
          <TraceView messages={messages} />
        </div>
      </div>
    </main>
  );
}

function ServerApp() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selection, setSelection] = useState<TraceSelection | null>(readHash);
  const [trace, setTrace] = useState<TraceState>({ status: "unselected" });
  const [appError, setAppError] = useState<string | null>(null);
  const traceRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchMeta()
      .then(setMeta)
      .catch((e) => setAppError(String(e)));
    fetchTree()
      .then(setTree)
      .catch((e) => setAppError(String(e)));
  }, []);

  // Single-file mode: auto-open the one trace.
  useEffect(() => {
    if (meta?.mode === "file" && tree && selection === null) {
      const target = defaultSelection(tree);
      if (target) select(target);
    }
  }, [meta, tree, selection]);

  useEffect(() => {
    if (selection === null) {
      setTrace({ status: "unselected" });
      return;
    }
    let stale = false;
    setTrace({ status: "loading" });
    fetchTrace(selection)
      .then((data) => {
        if (!stale) setTrace({ status: "ready", data });
      })
      .catch((e) => {
        if (!stale) setTrace({ status: "error", message: String(e) });
      });
    return () => {
      stale = true;
    };
  }, [selection]);

  // Live updates: refresh the tree on any change, re-fetch the open trace if it changed.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    return subscribeChanges((paths) => {
      fetchTree()
        .then(setTree)
        .catch(() => undefined);
      const current = selectionRef.current;
      if (current && paths.includes(current.path)) {
        fetchTrace(current)
          // Guard against the refetch resolving after the user moved on.
          .then((data) => {
            if (selectionRef.current === current) setTrace({ status: "ready", data });
          })
          .catch((e) => {
            if (selectionRef.current === current) {
              setTrace({ status: "error", message: String(e) });
            }
          });
      }
    });
  }, []);

  useEffect(() => {
    const onHashChange = () => setSelection(readHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function select(next: TraceSelection) {
    const encoded = next.path.split("/").map(encodeURIComponent).join("/");
    location.hash = `#/${encoded}${next.line !== undefined ? `:${next.line}` : ""}`;
    setSelection(next);
  }

  const messages = useMemo(
    () => (trace.status === "ready" ? parseTrace(trace.data.source) : []),
    [trace],
  );
  // File mode hides the tree — unless the file needs it (multi-trace or broken).
  const showTree =
    meta === null || meta.mode === "dir" || (tree !== null && defaultSelection(tree) === null);
  const title = selection
    ? `${selection.path}${selection.line !== undefined ? ` · trace ${selection.line}` : ""}`
    : (meta?.root ?? "");

  return (
    <div class="layout">
      {showTree && tree ? (
        <TreePane
          root={tree}
          rootLabel={meta?.root ?? ""}
          selection={selection}
          onSelect={select}
        />
      ) : null}
      <main class="main-pane">
        <header class="trace-header">
          <span class="trace-title">{title}</span>
          {selection && messages.length > 0 ? <TraceStatsBar messages={messages} /> : null}
          {selection && messages.length > 0 ? (
            <TraceSearch key={title} rootRef={traceRootRef} />
          ) : null}
          {selection && messages.length > 0 ? (
            <CopyTraceButton
              key={title}
              text={trace.status === "ready" ? trace.data.transcript : ""}
            />
          ) : null}
          <ThemeToggle />
        </header>
        <div class="trace-body">
          <div ref={traceRootRef}>
            {appError ? <div class="banner-error">{appError}</div> : null}
            <TraceContent trace={trace} messages={messages} />
          </div>
        </div>
      </main>
    </div>
  );
}

function TraceContent({
  trace,
  messages,
}: {
  trace: TraceState;
  messages: ReturnType<typeof parseTrace>;
}) {
  switch (trace.status) {
    case "unselected":
      return <div class="empty">Select a trace from the tree to inspect it.</div>;
    case "loading":
      return <div class="empty">Loading trace…</div>;
    case "error":
      return <div class="banner-error">{trace.message}</div>;
    case "ready":
      return messages.length === 0 ? (
        <div class="empty">This trace contains no messages.</div>
      ) : (
        <TraceView messages={messages} />
      );
  }
}

function readHash(): TraceSelection | null {
  const hash = location.hash;
  if (!hash.startsWith("#/") || hash.length <= 2) return null;
  // Split off the line before decoding so `:` and `%` in file names can't confuse parsing.
  const match = /^(.*?)(?::(\d+))?$/.exec(hash.slice(2));
  if (!match) return null;
  let path = match[1];
  try {
    path = decodeURIComponent(path);
  } catch {
    // hand-typed hash with a stray '%' — use it verbatim
  }
  return { path, line: match[2] !== undefined ? Number(match[2]) : undefined };
}
