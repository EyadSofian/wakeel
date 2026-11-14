import { useCallback } from "react";
import { useCanvasStore } from "../canvas/context";
import { type CanvasStore, isDirty } from "../canvas/store/store";
import { useEmulatorStoreOptional } from "./controller";

/**
 * Resolves once autosave has nothing pending, so a test turn runs the draft the builder sees, not
 * the one before their last edit. Gives up after `timeoutMs`: a draft that cannot save (offline, a
 * conflict) still lets the builder test what is on the server.
 */
export function waitForSaved(store: CanvasStore, timeoutMs = 5_000): Promise<void> {
  const settled = () =>
    store
      .getState()
      .docs()
      .every(
        (d) => !d.state.saving && (!isDirty(d.state) || d.state.conflict !== undefined || d.state.error !== undefined),
      );
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = store.subscribe(() => settled() && done());
    function done() {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

/** "Run from here" for a node of the open workflow (`⌘Enter`, node menu); undefined off the canvas. */
export function useRunFrom(): ((nodeId: string) => void) | undefined {
  const emulator = useEmulatorStoreOptional();
  const canvas = useCanvasStore();
  const run = useCallback(
    (nodeId: string) => {
      const s = canvas.getState();
      const workflowId = s.activeWorkflowId;
      const node = workflowId ? s.workflows[workflowId]?.doc.nodes.find((n) => n.id === nodeId) : undefined;
      if (!emulator || !workflowId || !node) return;
      void emulator.getState().runFrom(workflowId, node.id, node.name);
    },
    [canvas, emulator],
  );
  return emulator ? run : undefined;
}
