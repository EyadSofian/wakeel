import type { Node, Workflow } from "@wakeel/contracts";
import { useCallback } from "react";
import { useCanvasStore } from "../context";
import { type Command, commands } from "../store/commands";
import { copyFragment } from "./clipboard";
import { useUiStore } from "./ui-store";

/** How far a duplicate sits from its original. */
export const DUPLICATE_OFFSET = 32;

/** Start and entry nodes are where a workflow begins; they cannot be deleted or duplicated. */
export const isFixedNode = (node: Pick<Node, "type">) => node.type === "start" || node.type === "entry";

/** The ids among `nodeIds` that may be deleted: they exist and are not a workflow's entry point. */
export function deletableNodeIds(wf: Workflow | undefined, nodeIds: readonly string[]): string[] {
  return nodeIds.filter((id) => {
    const node = wf?.nodes.find((n) => n.id === id);
    return node !== undefined && !isFixedNode(node);
  });
}

/** The paste command that copies `nodeIds` (and the edges between them) one offset down and right. */
export function duplicateCommand(
  wf: Workflow | undefined,
  nodeIds: readonly string[],
): (Command & { created: string[] }) | undefined {
  const fragment = wf ? copyFragment(wf, deletableNodeIds(wf, nodeIds)) : undefined;
  if (!fragment) return undefined;
  const at = Object.values(fragment.layout);
  return commands.paste(fragment, {
    x: Math.min(...at.map((p) => p.x)) + DUPLICATE_OFFSET,
    y: Math.min(...at.map((p) => p.y)) + DUPLICATE_OFFSET,
  });
}

/**
 * Duplicate and delete for given nodes, for the node menu and the inspector. The keyboard and the
 * command palette (`useCanvasActions`) build the same commands, so every way does the same thing in
 * one undo step.
 */
export function useNodeActions() {
  const store = useCanvasStore();
  const ui = useUiStore();

  const workflow = useCallback(() => {
    const s = store.getState();
    return s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined;
  }, [store]);

  const duplicate = useCallback(
    (nodeIds: readonly string[]) => {
      const command = duplicateCommand(workflow(), nodeIds);
      if (!command || !store.getState().execute(command).ok) return false;
      ui.getState().markFresh(command.created);
      store.getState().select({ nodeIds: command.created, edgeIds: [], card: undefined });
      return true;
    },
    [store, ui, workflow],
  );

  const remove = useCallback(
    (nodeIds: readonly string[]) => {
      const ids = deletableNodeIds(workflow(), nodeIds);
      if (ids.length === 0) return false;
      if (!store.getState().execute(commands.deleteNodes(ids)).ok) return false;
      store.getState().clearSelection();
      return true;
    },
    [store, workflow],
  );

  return { duplicate, remove };
}
