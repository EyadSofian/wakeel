import type { NodeType } from "@wakeel/contracts";
import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";
import { useCanvasStore } from "./context";
import { type Port, useUiStore } from "./interaction/ui-store";
import { commands } from "./store/commands";
import { createNode } from "./store/factories";

const SNAP = 8;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/**
 * Adds a node of `type` with its top-left at a screen point (the pointer, a drop, the add-node
 * menu) or, without one, at the centre of the canvas, and selects it so the inspector opens on it.
 * With `from`, the new node is wired from that output in the same undo step. Used by the node
 * library, the add-node menu, `N` and drag-and-drop, so every way of adding a node behaves the same.
 */
export function useAddNode() {
  const store = useCanvasStore();
  const ui = useUiStore();
  const flow = useReactFlow();
  return useCallback(
    (type: NodeType, screen?: { x: number; y: number }, from?: Port) => {
      const pane = document.querySelector(".wk-canvas")?.getBoundingClientRect();
      const at = screen ?? (pane ? { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 } : { x: 0, y: 0 });
      const p = flow.screenToFlowPosition(at);
      const node = createNode(type);
      const position = { x: snap(p.x), y: snap(p.y) };
      const result = store
        .getState()
        .execute(from ? commands.addNodeFrom(node, position, from) : commands.addNode(node, position));
      if (result.ok) {
        ui.getState().markFresh([node.id]);
        store.getState().select({ nodeIds: [node.id], edgeIds: [] });
      }
      return result;
    },
    [flow, store, ui],
  );
}
