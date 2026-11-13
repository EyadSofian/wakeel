import { NON_TARGETABLE_NODE_TYPES } from "@wakeel/contracts";
import { useConnection, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import type { CanvasRFNode } from "../view/CanvasNode";
import { useUiStore } from "./ui-store";

/**
 * While a transition is dragged, marks the node under its free end as the drop target (§5.1
 * motion table: valid targets show their start edge in `--accent-border`). Hit-tested in canvas
 * coordinates, because nodes get no pointer events during the drag.
 */
export function ConnectionWatcher() {
  const ui = useUiStore();
  const flow = useReactFlow<CanvasRFNode>();
  // Primitives only, so each selector returns a stable value between renders.
  const x = useConnection((c) => (c.inProgress ? c.to.x : undefined));
  const y = useConnection((c) => (c.inProgress ? c.to.y : undefined));
  const from = useConnection((c) => (c.inProgress ? c.fromNode.id : undefined));
  useEffect(() => {
    if (x === undefined || y === undefined) {
      if (ui.getState().dropTarget !== undefined) ui.getState().set({ dropTarget: undefined });
      return;
    }
    const hit = flow
      .getNodes()
      .find(
        (n) =>
          n.id !== from &&
          !NON_TARGETABLE_NODE_TYPES.includes(n.data.node.type) &&
          x >= n.position.x &&
          x <= n.position.x + (n.measured?.width ?? 0) &&
          y >= n.position.y &&
          y <= n.position.y + (n.measured?.height ?? 0),
      );
    if (ui.getState().dropTarget !== hit?.id) ui.getState().set({ dropTarget: hit?.id });
  }, [x, y, from, flow, ui]);
  return null;
}
