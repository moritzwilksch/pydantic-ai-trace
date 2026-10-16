import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { embeddedPayload, fetchMeta, fetchTrace, fetchTree, subscribeChanges } from "./api";
import { indexTrajectory, type RunEntry, type TrajectoryIndex } from "./runIndex";
import { defaultSelection } from "./selection";
import { CopyTraceButton } from "./components/CopyTraceButton";
import { KeyboardHelp, useKeyboardNav } from "./components/KeyboardNav";
import { RunBreadcrumb } from "./components/RunBreadcrumb";
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
      {embedded ? <ExportedApp payload={embedded} /> : <ServerApp />}
      {helpOpen ? <KeyboardHelp onClose={closeHelp} /> : null}
    </>
  );
}

/** Exported HTML: one embedded payload, with a runs sidebar for a trajectory. */
function ExportedApp({ payload }: { payload: TracePayload }) {
  const runs = useRuns(payload, payload.name);
  return (
    <div class="layout">
      {runs?.multiRun ? (
        <nav class="tree-pane">
          <div class="tree-header" title={payload.name}>
            {payload.name}
          </div>
          <div class="tree-body">
            <RunTreeFor runs={runs} />
          </div>
        </nav>
      ) : null}
      <TracePane title={payload.name} payload={payload} runs={runs} />
    </div>
  );
}

interface Runs {
  trajectory: TrajectoryIndex;
  selected: RunEntry;
  select: (runId: string) => void;
  multiRun: boolean;
}

/**
 * The payload's runs and the selected one. The selection survives live reloads
 * while the run still exists and resets when `traceKey` names another trace.
 */
function useRuns(payload: TracePayload | null, traceKey: string): Runs | null {
  const [choice, setChoice] = useState<{ traceKey: string; runId: string } | null>(null);
  const trajectory = useMemo(() => (payload ? indexTrajectory(payload) : null), [payload]);
  if (trajectory === null) return null;
  const chosen = choice?.traceKey === traceKey ? trajectory.entries.get(choice.runId) : undefined;
  return {
    trajectory,
    selected: chosen ?? trajectory.roots[0],
    select: (runId) => setChoice({ traceKey, runId }),
    multiRun: trajectory.entries.size > 1,
  };
}

function RunTreeFor({ runs }: { runs: Runs }) {
  return (
    <RunTree trajectory={runs.trajectory} selected={runs.selected.run.id} onSelect={runs.select} />
  );
}

/**
 * One trace: its header and the selected run. `placeholder` replaces the body
 * while no payload is loaded.
 */
function TracePane({
  title,
  payload,
  runs,
  placeholder,
  banner,
}: {
  title: string;
  payload: TracePayload | null;
  runs: Runs | null;
  placeholder?: ComponentChildren;
  banner?: ComponentChildren;
}) {
  const traceRootRef = useRef<HTMLDivElement>(null);
  return (
    <main class="main-pane">
      <header class="trace-header">
        <RunBreadcrumb
          title={title}
          trajectory={runs?.trajectory ?? null}
          selected={runs?.selected ?? null}
          onSelect={(runId) => runs?.select(runId)}
        />
        {payload && runs ? (
          <>
            <TraceStatsBar
              totals={runs.selected.analysis.totals}
              subtreeTotals={runs.selected.analysis.subtree_totals}
            />
            <TraceSearch key={`${title}/${runs.selected.run.id}`} rootRef={traceRootRef} />
            <CopyTraceButton key={title} text={payload.transcript} />
          </>
        ) : null}
        <ThemeToggle />
      </header>
      <div class="trace-body">
        <div ref={traceRootRef}>
          {banner}
          {runs ? (
            <TraceView
              key={runs.selected.run.id}
              entry={runs.selected}
              trajectory={runs.trajectory}
              onOpenRun={runs.select}
            />
          ) : (
            placeholder
          )}
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

  const title = selection
    ? `${selection.path}${selection.line !== undefined ? ` · trace ${selection.line}` : ""}`
    : (meta?.root ?? "");
  const payload = trace.status === "ready" ? trace.data : null;
  const runs = useRuns(payload, title);
  // File mode hides the tree — unless the file needs it (multi-trace, broken, or several runs).
  const showTree =
    meta === null ||
    meta.mode === "dir" ||
    (tree !== null && defaultSelection(tree) === null) ||
    Boolean(runs?.multiRun);

  return (
    <div class="layout">
      {showTree && tree ? (
        <TreePane
          root={tree}
          rootLabel={meta?.root ?? ""}
          selection={selection}
          onSelect={select}
          selectedChildren={runs?.multiRun ? <RunTreeFor runs={runs} /> : null}
        />
      ) : null}
      <TracePane
        key={title}
        title={title}
        payload={payload}
        runs={runs}
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
