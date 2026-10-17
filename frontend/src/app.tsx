import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  embeddedPayload,
  FetchError,
  fetchMeta,
  fetchTrace,
  fetchTree,
  subscribeChanges,
} from "./api";
import { indexTrajectory, type RunEntry, type TrajectoryIndex } from "./runIndex";
import {
  defaultSelection,
  formatHash,
  isMultiTrace,
  parseHash,
  sameSelection,
  type ViewLocation,
} from "./selection";
import { shownTrace, traceFailed, type TraceState } from "./traceState";
import { CopyTraceButton } from "./components/CopyTraceButton";
import { KeyboardHelp, useKeyboardNav } from "./components/KeyboardNav";
import { RunBreadcrumb } from "./components/RunBreadcrumb";
import { RunTree } from "./components/RunTree";
import {
  SIDEBAR_ID,
  SidebarBackdrop,
  SidebarToggle,
  useSidebar,
  type Sidebar,
} from "./components/Sidebar";
import { ThemeToggle } from "./components/ThemeToggle";
import { TraceSearch } from "./components/TraceSearch";
import { TraceStatsBar, TraceView } from "./components/TraceView";
import { TreePane } from "./components/TreePane";
import type { Meta, TracePayload, TraceSelection, TreeNode } from "./types";

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
  const [view, navigate] = useHashLocation();
  const runs = useRuns(payload, view.run, (run) => navigate({ trace: null, run }));
  const sidebar = useSidebar();
  return (
    <div class={layoutClass(sidebar)}>
      {runs?.multiRun ? (
        <nav class="tree-pane" id={SIDEBAR_ID}>
          <div class="tree-header" title={payload.name}>
            {payload.name}
          </div>
          <div class="tree-body">
            <div class="tree-children">
              <RunTreeFor runs={runs} onSelected={() => sidebar.setOpen(false)} />
            </div>
          </div>
        </nav>
      ) : null}
      <SidebarBackdrop sidebar={sidebar} />
      <TracePane
        title={payload.name}
        payload={payload}
        runs={runs}
        sidebar={runs?.multiRun ? sidebar : null}
      />
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
 * The payload's runs and the one `runId` names. An absent or unknown run falls back
 * to the first root run, so a stale link still opens the trace.
 */
function useRuns(
  payload: TracePayload | null,
  runId: string | undefined,
  select: (runId: string) => void,
): Runs | null {
  const trajectory = useMemo(() => (payload ? indexTrajectory(payload) : null), [payload]);
  if (trajectory === null) return null;
  const chosen = runId === undefined ? undefined : trajectory.entries.get(runId);
  return {
    trajectory,
    selected: chosen ?? trajectory.roots[0],
    select,
    multiRun: trajectory.entries.size > 1,
  };
}

/**
 * The view the URL hash names. `navigate` adds a history entry, so Back and Forward
 * restore earlier traces and runs, and a reload or shared link reopens the view.
 */
function useHashLocation(): [ViewLocation, (next: ViewLocation) => void] {
  const [view, setView] = useState(() => parseHash(location.hash));
  // Keep the trace object when only the run changes: a new object would refetch the trace.
  const update = (next: ViewLocation) =>
    setView((current) => ({
      trace: sameSelection(current.trace, next.trace) ? current.trace : next.trace,
      run: next.run,
    }));
  useEffect(() => {
    const onHashChange = () => update(parseHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const navigate = (next: ViewLocation) => {
    location.hash = formatHash(next);
    update(next);
  };
  return [view, navigate];
}

function RunTreeFor({ runs, onSelected }: { runs: Runs; onSelected: () => void }) {
  return (
    <RunTree
      trajectory={runs.trajectory}
      selected={runs.selected.run.id}
      onSelect={(runId) => {
        runs.select(runId);
        onSelected();
      }}
    />
  );
}

/** The sidebar overlays the trace on narrow screens while open; see `useSidebar`. */
function layoutClass(sidebar: Sidebar): string {
  return sidebar.open ? "layout sidebar-open" : "layout";
}

/**
 * One trace: its header and the selected run. `placeholder` replaces the body
 * while no payload is loaded. `sidebar` is null when there is no sidebar to toggle.
 */
function TracePane({
  title,
  payload,
  runs,
  sidebar,
  placeholder,
  banner,
}: {
  title: string;
  payload: TracePayload | null;
  runs: Runs | null;
  sidebar: Sidebar | null;
  placeholder?: ComponentChildren;
  banner?: ComponentChildren;
}) {
  const traceRootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const runId = runs?.selected.run.id;
  // Another run opens at its top; a live reload of the same run keeps its position.
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [runId]);
  return (
    <main class="main-pane">
      <header class="trace-header">
        {sidebar ? <SidebarToggle sidebar={sidebar} /> : null}
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
      <div class="trace-body" ref={bodyRef}>
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
  const [view, navigate] = useHashLocation();
  const selection = view.trace;
  const [trace, setTrace] = useState<TraceState>({ status: "unselected" });
  const [appError, setAppError] = useState<string | null>(null);
  const beginTreeRequest = useRequestOrder();
  const beginTraceRequest = useRequestOrder();
  const sidebar = useSidebar();

  // A save can trigger several change events, and their responses can arrive out
  // of order. Only the latest request may update the tree or the trace.
  function loadTree(onError: (error: unknown) => void) {
    const isLatest = beginTreeRequest();
    fetchTree()
      .then((next) => {
        if (isLatest()) setTree(next);
      })
      .catch((e) => {
        if (isLatest()) onError(e);
      });
  }

  function loadTrace(target: TraceSelection) {
    const isLatest = beginTraceRequest();
    fetchTrace(target)
      .then((data) => {
        if (isLatest()) setTrace({ status: "ready", selection: target, data });
      })
      .catch((e) => {
        if (!isLatest()) return;
        const message = e instanceof Error ? e.message : String(e);
        const details = e instanceof FetchError ? e.details : [];
        setTrace((current) => traceFailed(current, target, message, details));
      });
  }

  useEffect(() => {
    fetchMeta()
      .then(setMeta)
      .catch((e) => setAppError(String(e)));
    loadTree((e) => setAppError(String(e)));
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
      beginTraceRequest(); // discard a pending load
      setTrace({ status: "unselected" });
      return;
    }
    setTrace((current) => ({ status: "loading", previous: shownTrace(current) }));
    loadTrace(selection);
  }, [selection]);

  // Live updates: refresh the tree on any change, re-fetch the open trace if it changed.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    return subscribeChanges((paths) => {
      loadTree(() => undefined);
      const current = selectionRef.current;
      if (current && paths.includes(current.path)) loadTrace(current);
    });
  }, []);

  function select(next: TraceSelection) {
    navigate({ trace: next });
    sidebar.setOpen(false);
  }

  const shown = shownTrace(trace);
  const shownSelection = shown?.selection ?? selection;
  const title = shownSelection ? selectionTitle(shownSelection) : (meta?.root ?? "");
  const payload = shown?.data ?? null;
  // The run names a run of the selected trace; while that trace loads, the previous
  // one shows its root run unless it has a run of that ID.
  const runs = useRuns(payload, view.run, (run) => navigate({ trace: selection, run }));
  // Runs nest under the trace they belong to, not under a newer selection still loading.
  const runsUnderSelection =
    runs?.multiRun &&
    shown &&
    selection &&
    selectionTitle(shown.selection) === selectionTitle(selection)
      ? runs
      : null;
  // File mode hides the tree — unless the file needs it (multi-trace, broken with
  // nothing to show, or several runs).
  const showTree =
    meta === null ||
    meta.mode === "dir" ||
    (tree !== null && (isMultiTrace(tree) || (defaultSelection(tree) === null && !shown))) ||
    Boolean(runs?.multiRun);

  return (
    <div class={layoutClass(sidebar)}>
      {showTree && tree ? (
        <TreePane
          id={SIDEBAR_ID}
          root={tree}
          rootLabel={meta?.root ?? ""}
          selection={selection}
          onSelect={select}
          selectedChildren={
            runsUnderSelection ? (
              <RunTreeFor runs={runsUnderSelection} onSelected={() => sidebar.setOpen(false)} />
            ) : null
          }
        />
      ) : null}
      <SidebarBackdrop sidebar={sidebar} />
      <TracePane
        key={title}
        title={title}
        payload={payload}
        runs={runs}
        sidebar={showTree && tree ? sidebar : null}
        banner={
          <>
            {appError ? <div class="banner-error">{appError}</div> : null}
            {trace.status === "stale" ? (
              <div class="banner-warn" role="status">
                File currently invalid: {trace.message}; showing last valid version.
                <ErrorDetails details={trace.details} />
              </div>
            ) : null}
          </>
        }
        placeholder={<TraceStatus trace={trace} />}
      />
    </div>
  );
}

/**
 * Orders requests of one kind. `begin()` starts a request and returns `isLatest`,
 * which turns false once a later request begins.
 */
function useRequestOrder(): () => () => boolean {
  const latest = useRef(0);
  return () => {
    const request = ++latest.current;
    return () => latest.current === request;
  };
}

function selectionTitle(selection: TraceSelection): string {
  return `${selection.path}${selection.line !== undefined ? ` · trace ${selection.line}` : ""}`;
}

function TraceStatus({ trace }: { trace: TraceState }) {
  switch (trace.status) {
    case "unselected":
      return <div class="empty">Select a trace from the tree to inspect it.</div>;
    case "loading":
      return <div class="empty">Loading trace…</div>;
    case "error":
      return (
        <div class="banner-error">
          {trace.message}
          <ErrorDetails details={trace.details} />
        </div>
      );
    case "ready":
    case "stale":
      return null;
  }
}

/** Every validation error of a broken trace, collapsed; nothing for a single error. */
function ErrorDetails({ details }: { details: string[] }) {
  if (details.length < 2) return null;
  return (
    <details class="error-details">
      <summary>Show all {details.length} errors</summary>
      <ul>
        {details.map((detail, i) => (
          <li key={i}>{detail}</li>
        ))}
      </ul>
    </details>
  );
}
