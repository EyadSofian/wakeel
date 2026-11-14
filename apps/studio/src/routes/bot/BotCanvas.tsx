import { Link } from "@tanstack/react-router";
import type { DefinitionIssue } from "@wakeel/contracts";
import { Badge, Banner, Button, Skeleton } from "@wakeel/ui";
import { ReactFlowProvider } from "@xyflow/react";
import { CircleAlert, CircleCheck, LoaderCircle, Play, Rocket, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { ApiError } from "../../api/client";
import { useWorkspace } from "../../api/queries";
import { useAddNode } from "../../canvas/add-node";
import { useCanvas, useCanvasStore } from "../../canvas/context";
import { createUiStore, UiStoreContext } from "../../canvas/interaction/ui-store";
import { groupIssues, useIssues } from "../../canvas/issues";
import { NodeLibrary } from "../../canvas/library/NodeLibrary";
import { isDirty } from "../../canvas/store/store";
import { useSummaryContext } from "../../canvas/use-summary";
import { Canvas } from "../../canvas/view/Canvas";
import { emulatorBase, fetchTransport } from "../../emulator/api";
import {
  createEmulatorStore,
  EmulatorStoreContext,
  useEmulator,
  useEmulatorStoreOptional,
} from "../../emulator/controller";
import { EmulatorPanel } from "../../emulator/EmulatorPanel";
import { waitForSaved } from "../../emulator/run-from";
import { Inspector } from "../../inspector/Inspector";
import { AppShell } from "../../shell/AppShell";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { type LoadState, useLoadState } from "./BotLayout";

/**
 * The bot canvas screen (design system §5.1): top bar with the breadcrumb, save state and issue
 * count, then the canvas of the open workflow. The draft is loaded by `BotLayout`.
 */
export function BotCanvas({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const state = useLoadState();
  return <Body workspaceId={workspaceId} botId={botId} state={state} />;
}

/** Inside the store provider: validates once and shares the result with the top bar and canvas. */
function Body({ workspaceId, botId, state }: { workspaceId: string; botId: string; state: LoadState }) {
  const [ui] = useState(createUiStore);
  const canvas = useCanvasStore();
  // One emulator per open bot: its test conversation survives moving between workflows.
  const [emulator] = useState(() =>
    createEmulatorStore({
      base: emulatorBase(workspaceId, botId),
      transport: fetchTransport,
      beforeTurn: () => waitForSaved(canvas),
    }),
  );
  return (
    <ReactFlowProvider>
      <UiStoreContext.Provider value={ui}>
        <EmulatorStoreContext.Provider value={emulator}>
          <Frame workspaceId={workspaceId} botId={botId} state={state} />
        </EmulatorStoreContext.Provider>
      </UiStoreContext.Provider>
    </ReactFlowProvider>
  );
}

/** The end side: the emulator while it is open, otherwise the inspector for the selection. */
function SidePanel({ issues, summary }: { issues: DefinitionIssue[]; summary: ReturnType<typeof useSummaryContext> }) {
  const open = useEmulator((s) => s.open);
  const setOpen = useEmulator((s) => s.setOpen);
  return open ? (
    <EmulatorPanel onShowInspector={() => setOpen(false)} />
  ) : (
    <Inspector issues={issues} summary={summary} />
  );
}

function Frame({ workspaceId, botId, state }: { workspaceId: string; botId: string; state: LoadState }) {
  const result = useIssues();
  const issues = useMemo(() => result ?? [], [result]);
  const active = useCanvas((s) => s.activeWorkflowId);
  const grouped = useMemo(() => groupIssues(issues, active), [issues, active]);
  const summary = useSummaryContext();
  const addNode = useAddNode();
  const ready = state === "ready";
  return (
    <AppShell
      title={<Breadcrumb workspaceId={workspaceId} ready={ready} />}
      active="Workflows"
      workspaceId={workspaceId}
      botId={botId}
      actions={ready ? <TopBarStatus issues={issues} validated={result !== undefined} /> : null}
      panel={ready ? <NodeLibrary onAdd={(type) => addNode(type)} /> : null}
      inspector={ready ? <SidePanel issues={issues} summary={summary} /> : null}
    >
      {state === "loading" ? (
        <CanvasSkeleton />
      ) : ready ? (
        <Canvas issues={grouped} />
      ) : (
        <div className="mx-auto max-w-page px-9 py-9">
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

/** Workspace / bot / page; the page is the open workflow unless a screen names another. */
export function Breadcrumb({ workspaceId, ready, page }: { workspaceId: string; ready: boolean; page?: string }) {
  const workspace = useWorkspace(workspaceId);
  const bot = useCanvas((s) => s.manifest?.doc.name);
  const open = useCanvas((s) => (s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc.name : undefined));
  const wf = page ?? open;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-3 text-body">
      {workspace.data ? (
        <Link
          to="/w/$workspaceId"
          params={{ workspaceId }}
          className="truncate text-secondary hover:text-primary"
          dir="auto"
        >
          {workspace.data.name}
        </Link>
      ) : (
        <Skeleton className="h-4 w-11" />
      )}
      <span aria-hidden="true" className="text-tertiary">
        /
      </span>
      {ready ? (
        <span dir="auto" className="truncate text-secondary">
          {bot}
        </span>
      ) : (
        <Skeleton className="h-4 w-12" />
      )}
      <span aria-hidden="true" className="text-tertiary">
        /
      </span>
      {ready ? (
        <span dir="auto" className="truncate font-medium text-primary" aria-current="page">
          {wf}
        </span>
      ) : (
        <Skeleton className="h-4 w-11" />
      )}
      {ready ? <Badge tone="info">Draft</Badge> : null}
    </nav>
  );
}

/** Save state (§4 SaveIndicator) and the issue count. */
export function TopBarStatus({ issues: all, validated }: { issues: DefinitionIssue[]; validated: boolean }) {
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
    <div className="flex items-center gap-6" data-validated={validated}>
      <span
        role="status"
        aria-live="polite"
        className={`flex items-center gap-2 text-small ${conflict || failed ? "text-warning" : "text-secondary"}`}
      >
        {conflict || failed ? null : saving ? (
          <LoaderCircle className="size-icon-sm" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <CircleCheck className="size-icon-sm text-success" strokeWidth={1.75} aria-hidden="true" />
        )}
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
      <span aria-hidden="true" className="h-control-sm border-s border-hairline" />
      <TestButton />
      {/* Publishing arrives with versions (7.1). */}
      <Button
        variant="primary"
        icon={<Rocket className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
        disabled
        title="Publishing is not available yet"
      >
        Publish
      </Button>
    </div>
  );
}

/** Opens and closes the emulator (§5.3); off the canvas, where there is none, it is disabled. */
function TestButton() {
  const emulator = useEmulatorStoreOptional();
  const open = useStore(emulator ?? NO_EMULATOR, (s) => s.open);
  return (
    <Button
      icon={<Play className="size-icon" strokeWidth={1.75} aria-hidden="true" />}
      aria-pressed={emulator ? open : undefined}
      disabled={!emulator}
      title={emulator ? (open ? "Close the emulator" : "Test the draft in the emulator") : "Open the canvas to test"}
      onClick={() => emulator?.getState().setOpen(!open)}
    >
      Test
    </Button>
  );
}

/** Stands in for a missing emulator so the hook order stays the same. */
const NO_EMULATOR = createStore(() => ({ open: false }));

/** Node-shaped placeholders while the draft loads: header tile and two lines, then rows. */
function NodeSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex w-node flex-col gap-4 rounded-lg border border-hairline bg-surface p-5">
      <div className="flex items-center gap-4">
        <Skeleton className="size-tile rounded-sm" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-3 w-11" />
        </div>
      </div>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders with no identity.
        <Skeleton key={i} className="h-row-card w-full rounded-sm" />
      ))}
    </div>
  );
}

function CanvasSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Opening the workflow"
      className="flex h-full items-start gap-11 bg-canvas px-11 py-12"
    >
      <NodeSkeleton rows={0} />
      <NodeSkeleton rows={3} />
      <NodeSkeleton rows={2} />
    </div>
  );
}
