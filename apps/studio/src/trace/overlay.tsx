import type { Workflow } from "@wakeel/contracts";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useCanvas, useCanvasStore } from "../canvas/context";
import { useEmulatorStoreOptional } from "../emulator/controller";
import { EMPTY_OVERLAY, type RunOverlay, runOverlay } from "./model";

const RunOverlayContext = createContext<RunOverlay>(EMPTY_OVERLAY);

/** What the last emulator turn went through, for the canvas to tint (§5.1 "Run overlay"). */
export const useRunOverlay = () => useContext(RunOverlayContext);

/** Stands in for a missing emulator so the hook order stays the same. */
const NONE = createStore(() => ({
  overlayTurn: undefined as string | undefined,
  traces: {} as Record<string, never[]>,
}));

/**
 * Computes the overlay once per turn for every node and edge below, and clears it on the next edit
 * of any document: a path drawn over a changed flow would be wrong.
 */
export function RunOverlayProvider({ children }: { children: ReactNode }) {
  const emulator = useEmulatorStoreOptional();
  const turn = useStore(emulator ?? NONE, (s) => s.overlayTurn);
  const spans = useStore(emulator ?? NONE, (s) => (s.overlayTurn ? s.traces[s.overlayTurn] : undefined));
  const workflows = useCanvas((s) => s.workflows);
  const canvas = useCanvasStore();

  useEffect(() => {
    if (!emulator) return;
    const docsOf = (s: ReturnType<typeof canvas.getState>) => [
      s.manifest?.doc,
      ...Object.values(s.workflows).map((w) => w.doc),
    ];
    return canvas.subscribe((next, prev) => {
      const a = docsOf(next);
      const b = docsOf(prev);
      if (a.length !== b.length || a.some((doc, i) => doc !== b[i])) emulator.getState().clearOverlay();
    });
  }, [canvas, emulator]);

  const overlay = useMemo(() => {
    if (!turn || !spans) return EMPTY_OVERLAY;
    const docs: Record<string, Workflow> = {};
    for (const [id, w] of Object.entries(workflows)) docs[id] = w.doc;
    return runOverlay(spans, docs);
  }, [turn, spans, workflows]);

  return <RunOverlayContext.Provider value={overlay}>{children}</RunOverlayContext.Provider>;
}
