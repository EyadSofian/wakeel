import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasStore } from "../canvas/context";
import { useIssues } from "../canvas/issues";
import { CommandPalette } from "./CommandPalette";
import { IssuesPanel } from "./IssuesPanel";
import { issueKey, orderIssues, stepIssue } from "./issue-order";
import { type Action, createShellStore, type Shell, ShellContext, useRegisterActions, useShell } from "./shell-store";
import { useGoTo } from "./use-go-to";
import { useWorkflowRequests, WorkflowDialogs } from "./WorkflowDialogs";
import { deleteBlocker, duplicateBlocker } from "./workflows";

/**
 * Everything a bot's screens share above the screen itself (task 2.8): validation of the whole
 * draft, the command palette (`⌘K`), the Issues panel and `F8` / `⇧F8`, and the workflow dialogs.
 * The canvas and the Variables screen render inside it, so all of these work on both.
 */
export function ShellProvider({
  workspaceId,
  botId,
  ready,
  children,
}: {
  workspaceId: string;
  botId: string;
  /** The draft has loaded; the palette and panels need it. */
  ready: boolean;
  children: ReactNode;
}) {
  const [store] = useState(createShellStore);
  const issues = useIssues();
  const shell = useMemo<Shell>(() => ({ store, workspaceId, botId, issues }), [store, workspaceId, botId, issues]);
  return (
    <ShellContext.Provider value={shell}>
      {children}
      {ready ? (
        <>
          <ShellActions />
          <ShellKeys />
          <CommandPalette />
          <IssuesPanel />
          <WorkflowDialogs />
        </>
      ) : null}
    </ShellContext.Provider>
  );
}

/** `F8` / `⇧F8`: jump to the next or previous issue (design system §5.16). */
function useStepIssue() {
  const { store, issues } = useShell();
  const go = useGoTo();
  return (direction: 1 | -1): boolean => {
    const next = stepIssue(orderIssues(issues ?? []), store.getState().issueAt, direction);
    if (!next?.workflowId) return false;
    store.getState().set({ issueAt: issueKey(next), issuesPanel: false });
    go.place({
      workflowId: next.workflowId,
      ...(next.nodeId ? { nodeId: next.nodeId } : {}),
      ...(next.cardId ? { cardId: next.cardId } : {}),
      path: next.path,
    });
    return true;
  };
}

function ShellKeys() {
  const { store } = useShell();
  const step = useStepIssue();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const s = store.getState();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        // Over another dialog the palette would stack two modals; finish that one first.
        if (!s.palette && document.querySelector('[role="dialog"][data-state="open"]')) return;
        e.preventDefault();
        s.set({ palette: !s.palette });
      } else if (e.key === "F8" && !s.palette && !s.dialog) {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });
  return null;
}

/** The shell's own palette actions: workflows and issues. */
function ShellActions() {
  const { store, issues } = useShell();
  const canvas = useCanvasStore();
  // Read when an action runs, so the list is rebuilt only when "is there an issue" changes.
  const stepNow = useStepIssue();
  const requestsNow = useWorkflowRequests();
  const step = useRef(stepNow);
  step.current = stepNow;
  const requests = useRef(requestsNow);
  requests.current = requestsNow;
  const jumpable = (issues ?? []).some((i) => i.workflowId !== undefined);
  const actions = useMemo<Action[]>(() => {
    const open = () => {
      const s = canvas.getState();
      return s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined;
    };
    return [
      {
        id: "shell.new-workflow",
        label: "New workflow",
        keywords: "create sub-workflow",
        run: () => store.getState().set({ dialog: { kind: "new" } }),
      },
      {
        id: "shell.rename-workflow",
        label: "Rename workflow",
        unavailable: () => (open() ? undefined : "Open a workflow first"),
        run: () => {
          const wf = open();
          if (wf) store.getState().set({ dialog: { kind: "rename", workflowId: wf.id } });
        },
      },
      {
        id: "shell.duplicate-workflow",
        label: "Duplicate workflow",
        unavailable: () => {
          const wf = open();
          return wf ? duplicateBlocker(wf) : "Open a workflow first";
        },
        run: () => {
          const wf = open();
          if (!wf) return;
          void requests.current.duplicate(wf).then((error) => {
            if (error)
              store.getState().set({ dialog: { kind: "failed", title: "The workflow was not duplicated", error } });
          });
        },
      },
      {
        id: "shell.delete-workflow",
        label: "Delete workflow",
        unavailable: () => {
          const wf = open();
          return wf ? deleteBlocker(wf) : "Open a workflow first";
        },
        run: () => {
          const wf = open();
          if (wf) store.getState().set({ dialog: { kind: "delete", workflowId: wf.id } });
        },
      },
      {
        id: "shell.issues",
        label: "Show issues",
        keywords: "errors warnings problems",
        run: () => store.getState().set({ issuesPanel: true }),
      },
      {
        id: "shell.next-issue",
        label: "Next issue",
        keys: ["F8"],
        unavailable: () => (jumpable ? undefined : "Nothing to fix"),
        run: () => step.current(1),
      },
      {
        id: "shell.previous-issue",
        label: "Previous issue",
        keys: ["⇧", "F8"],
        unavailable: () => (jumpable ? undefined : "Nothing to fix"),
        run: () => step.current(-1),
      },
    ];
  }, [jumpable, store, canvas]);
  useRegisterActions("shell", actions);
  return null;
}
