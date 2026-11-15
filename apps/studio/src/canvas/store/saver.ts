import type { BotManifest, Workflow } from "@wakeel/contracts";
import { ApiError } from "../../api/client";
import { type CanvasStore, type DocKey, isDirty } from "./store";

/**
 * Autosave (task 2.3, architecture §3): 800 ms after the last change, every changed document is
 * saved with `If-Match`. A change made while a save is in flight is saved after it. A conflict
 * stops saving that document until the builder resolves it; other failures retry with backoff.
 */
export const AUTOSAVE_DELAY_MS = 800;
const MAX_RETRY_DELAY_MS = 30_000;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SaveDoc = (
  ref: { kind: "manifest" | "workflow"; docId: string },
  rev: number,
  doc: BotManifest | Workflow,
) => Promise<{ rev: number }>;

export interface Saver {
  /** Saves every changed document now (leaving the page, pressing ⌘S). */
  flush(): Promise<void>;
  stop(): void;
}

export function createSaver(options: { store: CanvasStore; save: SaveDoc; timers: Timers; delayMs?: number }): Saver {
  const { store, save, timers } = options;
  const delay = options.delayMs ?? AUTOSAVE_DELAY_MS;
  let timer: unknown;
  let failures = 0;
  let stopped = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = undefined;
      void saveDirty();
    }, ms);
  };

  const saveOne = async (key: DocKey) => {
    const started = store.getState().beginSave(key);
    if (!started) return;
    const state = store
      .getState()
      .docs()
      .find((d) => d.key === key)?.state;
    if (!state) return;
    try {
      const { rev } = await save({ kind: state.kind, docId: state.docId }, started.rev, started.doc);
      store.getState().finishSave(key, started.doc, rev);
      failures = 0;
    } catch (e) {
      if (e instanceof ApiError && e.code === "revision_conflict" && e.problem.current) {
        store.getState().failSave(key, { conflict: e.problem.current });
      } else {
        failures += 1;
        const problem = e instanceof ApiError ? e.problem : undefined;
        store.getState().failSave(key, {
          error: {
            title: problem?.title ?? "Changes could not be saved",
            fix: problem?.fix ?? "They are kept here; we will try again.",
          },
        });
      }
    }
  };

  const saveDirty = async () => {
    const keys = store
      .getState()
      .docs()
      .filter((d) => isDirty(d.state) && !d.state.saving && !d.state.conflict)
      .map((d) => d.key);
    await Promise.all(keys.map(saveOne));
    // Anything still changed (edited during the save, or a failure) gets another round.
    const pending = store
      .getState()
      .docs()
      .some((d) => isDirty(d.state) && !d.state.conflict && !d.state.saving);
    if (pending) schedule(failures === 0 ? delay : Math.min(delay * 2 ** failures, MAX_RETRY_DELAY_MS));
  };

  // Every change to any document restarts the countdown.
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.manifest?.doc !== prev.manifest?.doc || s.workflows !== prev.workflows) {
      const changed = store
        .getState()
        .docs()
        .some((d) => isDirty(d.state) && !d.state.saving && !d.state.conflict);
      if (changed) schedule(delay);
    }
  });

  return {
    async flush() {
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      await saveDirty();
    },
    stop() {
      stopped = true;
      unsubscribe();
      if (timer !== undefined) timers.clearTimeout(timer);
    },
  };
}
