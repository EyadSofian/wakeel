import type { NodeType } from "@wakeel/contracts";
import { useMotionTokens } from "@wakeel/ui";
import { type Node as FlowNode, useReactFlow } from "@xyflow/react";
import { useCallback } from "react";
import { useCanvasStore } from "./context";
import { type Port, useUiStore } from "./interaction/ui-store";
import { commands } from "./store/commands";
import { createNode } from "./store/factories";

const SNAP = 8;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

/** Size assumed for a node not measured yet: the node width token and a short standard node. */
const NEW_NODE = { width: 288, height: 136 };
const GAP = 32;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;

/**
 * The first spot at or near `start` where a new node does not cover another one: it tries the
 * start, then steps below, to the right and to the left of it in rings. Exported for tests.
 */
export function freeSpot(start: { x: number; y: number }, taken: readonly Box[]): { x: number; y: number } {
  const stepX = NEW_NODE.width + GAP;
  const stepY = NEW_NODE.height + GAP;
  const fits = (x: number, y: number) => !taken.some((b) => overlaps({ x, y, ...NEW_NODE }, b));
  if (fits(start.x, start.y)) return start;
  for (let ring = 1; ring <= 12; ring++) {
    for (const [dx, dy] of [
      [0, ring],
      [ring, 0],
      [ring, ring],
      [-ring, 0],
      [0, -ring],
      [-ring, ring],
      [ring, -ring],
      [-ring, -ring],
    ] as const) {
      const x = start.x + dx * stepX;
      const y = start.y + dy * stepY;
      if (fits(x, y)) return { x, y };
    }
  }
  return start;
}

const boxOf = (n: FlowNode): Box => ({
  x: n.position.x,
  y: n.position.y,
  width: n.measured?.width ?? NEW_NODE.width,
  height: n.measured?.height ?? NEW_NODE.height,
});

/**
 * Adds a node of `type` with its top-left at a screen point (the pointer, a drop, the add-node
 * menu) or, without one, in free space near the centre of the canvas, and selects it so the
 * inspector opens on it. Without a screen point the canvas then pans to the new node, since the
 * inspector opening narrows the canvas and could hide it.
 * With `from`, the new node is wired from that output in the same undo step. Used by the node
 * library, the add-node menu, `N` and drag-and-drop, so every way of adding a node behaves the same.
 */
export function useAddNode() {
  const store = useCanvasStore();
  const ui = useUiStore();
  const flow = useReactFlow();
  const tokens = useMotionTokens();
  return useCallback(
    (type: NodeType, screen?: { x: number; y: number }, from?: Port) => {
      const pane = document.querySelector(".wk-canvas")?.getBoundingClientRect();
      const at = screen ?? (pane ? { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 } : { x: 0, y: 0 });
      const p = flow.screenToFlowPosition(at);
      const node = createNode(type);
      const centred = screen ? p : { x: p.x - NEW_NODE.width / 2, y: p.y - NEW_NODE.height / 2 };
      const spot = screen ? centred : freeSpot(centred, flow.getNodes().map(boxOf));
      const position = { x: snap(spot.x), y: snap(spot.y) };
      const result = store
        .getState()
        .execute(from ? commands.addNodeFrom(node, position, from) : commands.addNode(node, position));
      if (result.ok) {
        ui.getState().markFresh([node.id]);
        store.getState().select({ nodeIds: [node.id], edgeIds: [] });
        // Two frames: one for the node to mount, one for the inspector to take its width.
        if (!screen) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const { zoom } = flow.getViewport();
              void flow.setCenter(position.x + NEW_NODE.width / 2, position.y + NEW_NODE.height / 2, {
                zoom,
                duration: tokens.reduced ? 0 : tokens.duration.slower * 1000,
              });
            }),
          );
        }
      }
      return result;
    },
    [flow, store, ui, tokens],
  );
}
