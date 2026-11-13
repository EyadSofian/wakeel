import { Link } from "@tanstack/react-router";
import type { DefinitionIssue } from "@wakeel/contracts";
import { Banner, Skeleton } from "@wakeel/ui";
import { ReactFlowProvider } from "@xyflow/react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { draftSaver, loadDraft } from "../../api/drafts";
import { useWorkspace } from "../../api/queries";
import { CanvasStoreContext, useCanvas } from "../../canvas/context";
import { groupIssues, useIssues } from "../../canvas/issues";
import { createSaver, type Saver } from "../../canvas/store/saver";
import { type CanvasStore, createCanvasStore, isDirty } from "../../canvas/store/store";
import { Canvas } from "../../canvas/view/Canvas";
import { AppShell } from "../../shell/AppShell";
import { ProblemBanner } from "../../shell/ProblemBanner";

/**
 * The bot canvas screen (design system §5.1): top bar with the breadcrumb, save state and issue
 * count, then the canvas of the open workflow. The draft loads once into a canvas store; autosave
 * writes it back.
 */
export function BotCanvas({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const store = useMemo<CanvasStore>(() => createCanvasStore(), []);
  const [state, setState] = useState<"loading" | "ready" | { error: unknown }>("loading");

  useEffect(() => {
    let saver: Saver | undefined;
    let cancelled = false;
    loadDraft(workspaceId, botId).then(
      (draft) => {
        if (cancelled) return;
        store.getState().load(draft);
        saver = createSaver({
          store,
          save: draftSaver(workspaceId, botId),
          timers: {
            setTimeout: (fn, ms) => window.setTimeout(fn, ms),
            clearTimeout: (h) => window.clearTimeout(h as number),
          },
        });
        setState("ready");
      },
      (error: unknown) => !cancelled && setState({ error }),
    );
    // Save anything pending when the screen closes.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (
        store
          .getState()
          .docs()
          .some((d) => isDirty(d.state))
      ) {
        void saver?.flush();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", beforeUnload);
      void saver?.flush().finally(() => saver?.stop());
    };
  }, [store, workspaceId, botId]);

  return (
    <CanvasStoreContext.Provider value={store}>
      <Body workspaceId={workspaceId} state={state} />
    </CanvasStoreContext.Provider>
  );
}

/** Inside the store provider: validates once and shares the result with the top bar and canvas. */
function Body({ workspaceId, state }: { workspaceId: string; state: "loading" | "ready" | { error: unknown } }) {
  const result = useIssues();
  const issues = useMemo(() => result ?? [], [result]);
  const active = useCanvas((s) => s.activeWorkflowId);
  const grouped = useMemo(() => groupIssues(issues, active), [issues, active]);
  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={state === "ready"} />}
      active="Workflows"
      workspaceId={workspaceId}
      actions={state === "ready" ? <TopBarStatus issues={issues} validated={result !== undefined} /> : null}
    >
      {state === "loading" ? (
        <CanvasSkeleton />
      ) : state === "ready" ? (
        <ReactFlowProvider>
          <Canvas issues={grouped} />
        </ReactFlowProvider>
      ) : (
        <div className="px-5 py-6">
          {state.error instanceof ApiError ? (
            <ProblemBanner error={state.error} />
          ) : (
            <Banner tone="error" title="The workflow could not be opened">
              Reload the page and try again.
            </Banner>
          )}
        </div>
      )}
    </AppShell>
  );
}

function Breadcrumb({ workspaceId, ready }: { workspaceId: string; ready: boolean }) {
  const workspace = useWorkspace(workspaceId);
  const bot = useCanvas((s) => s.manifest?.doc.name);
  const wf = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc.name : undefined));
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-3 text-body">
      <Link
        to="/w/$workspaceId"
        params={{ workspaceId }}
        className="truncate text-secondary hover:text-primary"
        dir="auto"
      >
        {workspace.data?.name ?? ""}
      </Link>
      <span aria-hidden="true" className="text-tertiary">
        /
      </span>
      <span dir="auto" className="truncate text-secondary">
        {ready ? bot : ""}
      </span>
      <span aria-hidden="true" className="text-tertiary">
        /
      </span>
      <span dir="auto" className="truncate font-medium text-primary" aria-current="page">
        {ready ? wf : ""}
      </span>
    </nav>
  );
}

/** Save state (§4 SaveIndicator) and the issue count. */
function TopBarStatus({ issues: all, validated }: { issues: DefinitionIssue[]; validated: boolean }) {
  const manifest = useCanvas((s) => s.manifest);
  const workflows = useCanvas((s) => s.workflows);
  const docs = [manifest, ...Object.values(workflows)];
  const errors = all.filter((i) => i.severity === "error").length;
  const warnings = all.length - errors;
  const conflict = docs.some((d) => d?.conflict);
  const failed = docs.some((d) => d?.error);
  const saving = docs.some((d) => d?.saving || (d && isDirty(d)));
  const label = conflict
    ? "Changed elsewhere"
    : failed
      ? "Offline — changes kept locally"
      : saving
        ? "Saving…"
        : "Saved";
  return (
    <div className="flex items-center gap-5" data-validated={validated}>
      <span
        role="status"
        aria-live="polite"
        className={`text-small ${conflict || failed ? "text-warning" : "text-secondary"}`}
      >
        {label}
      </span>
      {all.length > 0 ? (
        <span
          role="img"
          className="flex items-center gap-3 text-small text-secondary"
          aria-label={`${errors} errors, ${warnings} warnings`}
        >
          {errors > 0 ? (
            <span className="flex items-center gap-1">
              <CircleAlert className="size-icon-sm text-error" strokeWidth={1.5} aria-hidden="true" />
              <span className="tabular-nums">{errors}</span>
            </span>
          ) : null}
          {warnings > 0 ? (
            <span className="flex items-center gap-1">
              <TriangleAlert className="size-icon-sm text-warning" strokeWidth={1.5} aria-hidden="true" />
              <span className="tabular-nums">{warnings}</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function CanvasSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Opening the workflow"
      className="flex h-full items-start gap-11 bg-canvas px-11 py-11"
    >
      <Skeleton className="h-12 w-node" />
      <Skeleton className="h-12 w-node" />
    </div>
  );
}
