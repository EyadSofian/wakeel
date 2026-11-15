import type { Workflow } from "@wakeel/contracts";
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useCanvas, useCanvasStore } from "../canvas/context";
import { useEmulatorStoreOptional } from "../emulator/controller";
import { EMPTY_OVERLAY, playbackOverlay, playbackSchedule, type RunOverlay, runOverlay } from "./model";
import { PLAYBACK_TOTAL_MS } from "./playback";

const RunOverlayContext = createContext<RunOverlay>(EMPTY_OVERLAY);

/** What the last emulator turn went through, for the canvas to tint (§5.1 "Run overlay"). */
export const useRunOverlay = () => useContext(RunOverlayContext);

/** Stands in for a missing emulator so the hook order stays the same. */
const NONE = createStore(() => ({
  overlayTurn: undefined as string | undefined,
  traces: {} as Record<string, never[]>,
  playback: undefined as { turnId: string; index: number } | undefined,
}));

/**
 * Computes the overlay once per turn for every node and edge below, and clears it on the next edit
 * of any document: a path drawn over a changed flow would be wrong.
 */
export function RunOverlayProvider({ children }: { children: ReactNode }) {
  const emulator = useEmulatorStoreOptional();
  const turn = useStore(emulator ?? NONE, (s) => s.overlayTurn);
  const spans = useStore(emulator ?? NONE, (s) => (s.overlayTurn ? s.traces[s.overlayTurn] : undefined));
  // A replay (§5.3 "Trace playback") shows the path up to where it has got, and where it is now.
  const playback = useStore(emulator ?? NONE, (s) => s.playback);
  const played = useStore(emulator ?? NONE, (s) => (s.playback ? s.traces[s.playback.turnId] : undefined));
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

  const schedule = useMemo(() => (played ? playbackSchedule(played, PLAYBACK_TOTAL_MS) : []), [played]);
  const overlay = useMemo(() => {
    const docs: Record<string, Workflow> = {};
    for (const [id, w] of Object.entries(workflows)) docs[id] = w.doc;
    if (playback && schedule.length > 0) return playbackOverlay(schedule, playback.index, docs);
    if (!turn || !spans) return EMPTY_OVERLAY;
    return runOverlay(spans, docs);
  }, [turn, spans, workflows, playback, schedule]);

  return <RunOverlayContext.Provider value={overlay}>{children}</RunOverlayContext.Provider>;
}
