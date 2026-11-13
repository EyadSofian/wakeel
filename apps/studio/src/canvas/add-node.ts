import type { NodeType } from "@wakeel/contracts";
import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";
import { useCanvasStore } from "./context";
import { commands } from "./store/commands";
import { createNode } from "./store/factories";

const SNAP = 8;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/**
 * Adds a node of `type` with its top-left at a screen point (the pointer, a drop) or, without one, at
 * the centre of the canvas, and selects it so the inspector opens on it. Used by the node library,
 * double-click, `N` and drag-and-drop, so every way of adding a node behaves the same.
 */
export function useAddNode() {
  const store = useCanvasStore();
  const flow = useReactFlow();
  return useCallback(
    (type: NodeType, screen?: { x: number; y: number }) => {
      const pane = document.querySelector(".wk-canvas")?.getBoundingClientRect();
      const at = screen ?? (pane ? { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 } : { x: 0, y: 0 });
      const p = flow.screenToFlowPosition(at);
      const node = createNode(type);
      const result = store.getState().execute(commands.addNode(node, { x: snap(p.x), y: snap(p.y) }));
      if (result.ok) store.getState().select({ nodeIds: [node.id], edgeIds: [] });
      return result;
    },
    [flow, store],
  );
}
