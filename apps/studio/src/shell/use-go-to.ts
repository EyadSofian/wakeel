import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useCanvasStore } from "../canvas/context";
import type { GoToTarget, Page } from "./palette-items";
import { useShell } from "./shell-store";

/** A place inside a workflow: the Issues panel, `F8` and the palette jump here. */
export interface Place {
  workflowId: string;
  nodeId?: string;
  cardId?: string;
  /** An issue path: the inspector field there gets focus. */
  path?: string;
}

/**
 * Moves the builder to a place in the bot (task 2.8): opens its workflow on the canvas, selects the
 * node and card so the inspector shows them, and asks the canvas to reveal and focus them.
 */
export function useGoTo() {
  const canvas = useCanvasStore();
  const { store, workspaceId, botId } = useShell();
  const navigate = useNavigate();

  const page = useCallback(
    (p: Page) => {
      const params = { workspaceId, botId };
      switch (p) {
        case "canvas":
          return navigate({ to: "/w/$workspaceId/b/$botId", params });
        case "variables":
          return navigate({ to: "/w/$workspaceId/b/$botId/variables", params });
        case "home":
          return navigate({ to: "/w/$workspaceId", params: { workspaceId } });
        case "general":
          return navigate({ to: "/w/$workspaceId/settings/general", params: { workspaceId } });
        case "members":
          return navigate({ to: "/w/$workspaceId/settings/members", params: { workspaceId } });
        case "api-keys":
          return navigate({ to: "/w/$workspaceId/settings/api-keys", params: { workspaceId } });
      }
    },
    [navigate, workspaceId, botId],
  );

  const place = useCallback(
    (to: Place) => {
      const s = canvas.getState();
      if (!s.workflows[to.workflowId]) return;
      if (s.activeWorkflowId !== to.workflowId) s.open(to.workflowId);
      if (to.nodeId) {
        canvas.getState().select({
          nodeIds: [to.nodeId],
          edgeIds: [],
          card: to.cardId ? { nodeId: to.nodeId, cardId: to.cardId } : undefined,
        });
        store.getState().requestFocus({ nodeId: to.nodeId, ...(to.path ? { path: to.path } : {}) });
      } else {
        canvas.getState().clearSelection();
      }
      void page("canvas");
    },
    [canvas, store, page],
  );

  const target = useCallback(
    (t: GoToTarget) => {
      if (t.type === "page") return void page(t.page);
      if (t.type === "workflow") return place({ workflowId: t.workflowId });
      return place({ workflowId: t.workflowId, nodeId: t.nodeId, ...(t.cardId ? { cardId: t.cardId } : {}) });
    },
    [page, place],
  );

  return { page, place, target };
}
