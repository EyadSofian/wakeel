import { Link } from "@tanstack/react-router";
import { Badge, Banner, Skeleton } from "@wakeel/ui";
import { ReactFlowProvider } from "@xyflow/react";
import { useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { useWorkspace } from "../../api/queries";
import { useAddNode } from "../../canvas/add-node";
import { useCanvas } from "../../canvas/context";
import { createUiStore, UiStoreContext } from "../../canvas/interaction/ui-store";
import { groupIssues } from "../../canvas/issues";
import { NodeLibrary } from "../../canvas/library/NodeLibrary";
import { useSummaryContext } from "../../canvas/use-summary";
import { Canvas } from "../../canvas/view/Canvas";
import { CodeDrawer } from "../../code/CodeDrawer";
import { Inspector } from "../../inspector/Inspector";
import { AppShell } from "../../shell/AppShell";
import { ProblemBanner } from "../../shell/ProblemBanner";
import { useShell } from "../../shell/shell-store";
import { TopBarStatus } from "../../shell/TopBarStatus";
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
  return (
    <ReactFlowProvider>
      <UiStoreContext.Provider value={ui}>
        <Frame workspaceId={workspaceId} botId={botId} state={state} />
      </UiStoreContext.Provider>
    </ReactFlowProvider>
  );
}

function Frame({ workspaceId, botId, state }: { workspaceId: string; botId: string; state: LoadState }) {
  const result = useShell().issues;
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
      actions={ready ? <TopBarStatus /> : null}
      panel={ready ? <NodeLibrary onAdd={(type) => addNode(type)} /> : null}
      inspector={ready ? <Inspector issues={issues} summary={summary} /> : null}
    >
      {state === "loading" ? (
        <CanvasSkeleton />
      ) : ready ? (
        <div className="relative h-full">
          {/* A workflow opens with its own viewport: fitted, or centred on what a jump selected. */}
          <Canvas key={active} issues={grouped} />
          <CodeDrawer />
        </div>
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
