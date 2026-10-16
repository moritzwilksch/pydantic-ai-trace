import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { embeddedPayload, fetchMeta, fetchTrace, fetchTree, subscribeChanges } from "./api";
import { indexTrajectory, type RunEntry, type TrajectoryIndex } from "./runIndex";
import { defaultSelection } from "./selection";
import { CopyTraceButton } from "./components/CopyTraceButton";
import { KeyboardHelp, useKeyboardNav } from "./components/KeyboardNav";
import { RunTree } from "./components/RunTree";
import { ThemeToggle } from "./components/ThemeToggle";
import { TraceSearch } from "./components/TraceSearch";
import { TraceStatsBar, TraceView } from "./components/TraceView";
import { TreePane } from "./components/TreePane";
import type { Meta, TracePayload, TraceSelection, TreeNode } from "./types";

type TraceState =
  | { status: "unselected" }
  | { status: "loading" }
  | { status: "ready"; data: TracePayload }
  | { status: "error"; message: string };

export function App() {
  const embedded = useMemo(embeddedPayload, []);
  const { helpOpen, closeHelp } = useKeyboardNav();
  return (
    <>
      {embedded ? (
        <div class="layout">
          <TracePane title={embedded.name} payload={embedded} />
        </div>
      ) : (
        <ServerApp />
      )}
      {helpOpen ? <KeyboardHelp onClose={closeHelp} /> : null}
    </>
  );
}

/**
 * One trace: its header, the run tree when there are several runs, and the
 * selected run. `placeholder` replaces the body while no payload is loaded.
 */
function TracePane({
  title,
  payload,
  placeholder,
  banner,
}: {
  title: string;
  payload: TracePayload | null;
  placeholder?: ComponentChildren;
  banner?: ComponentChildren;
}) {
  const traceRootRef = useRef<HTMLDivElement>(null);
  const trajectory = useMemo(() => (payload ? indexTrajectory(payload) : null), [payload]);
  const [selectedRun, selectRun] = useRunSelection(trajectory);
  const multiRun = trajectory !== null && trajectory.entries.size > 1;
  return (
    <main class="main-pane">
      <header class="trace-header">
        <span class="trace-title">
          {title}
          {multiRun && selectedRun ? ` · ${selectedRun.run.name}` : ""}
        </span>
        {payload && selectedRun ? (
          <>
            <TraceStatsBar
              totals={selectedRun.analysis.totals}
              subtreeTotals={selectedRun.analysis.subtree_totals}
            />
            <TraceSearch key={`${title}/${selectedRun.run.id}`} rootRef={traceRootRef} />
            <CopyTraceButton key={title} text={payload.transcript} />
          </>
        ) : null}
        <ThemeToggle />
      </header>
      <div class={`trace-body${multiRun ? " with-runs" : ""}`}>
        {multiRun && selectedRun ? (
          <RunTree trajectory={trajectory} selected={selectedRun.run.id} onSelect={selectRun} />
        ) : null}
        <div ref={traceRootRef} class="trace-content">
          {banner}
          {trajectory && selectedRun ? (
            <TraceView
              key={selectedRun.run.id}
              entry={selectedRun}
              trajectory={trajectory}
              onOpenRun={selectRun}
            />
          ) : (
            placeholder
          )}
        </div>
      </div>
    </main>
  );
}

/** The selected run, kept across live reloads while it still exists; else the first root. */
function useRunSelection(
  trajectory: TrajectoryIndex | null,
): [RunEntry | null, (runId: string) => void] {
  const [runId, setRunId] = useState<string | null>(null);
  if (trajectory === null) return [null, setRunId];
  const selected =
    (runId !== null ? trajectory.entries.get(runId) : undefined) ?? trajectory.roots[0];
  return [selected ?? null, setRunId];
}

function ServerApp() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [selection, setSelection] = useState<TraceSelection | null>(readHash);
  const [trace, setTrace] = useState<TraceState>({ status: "unselected" });
  const [appError, setAppError] = useState<string | null>(null);

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
      <TracePane
        key={title}
        title={title}
        payload={trace.status === "ready" ? trace.data : null}
        banner={appError ? <div class="banner-error">{appError}</div> : null}
        placeholder={<TraceStatus trace={trace} />}
      />
    </div>
  );
}

function TraceStatus({ trace }: { trace: TraceState }) {
  switch (trace.status) {
    case "unselected":
      return <div class="empty">Select a trace from the tree to inspect it.</div>;
    case "loading":
      return <div class="empty">Loading trace…</div>;
    case "error":
      return <div class="banner-error">{trace.message}</div>;
    case "ready":
      return null;
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
