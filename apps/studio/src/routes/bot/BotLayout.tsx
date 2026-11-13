import { Outlet } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { draftSaver, loadDraft } from "../../api/drafts";
import { CanvasStoreContext } from "../../canvas/context";
import { createSaver, type Saver } from "../../canvas/store/saver";
import { type CanvasStore, createCanvasStore, isDirty } from "../../canvas/store/store";

export type LoadState = "loading" | "ready" | { error: unknown };

const LoadStateContext = createContext<LoadState>("loading");

/** Whether the open bot's draft has loaded, for the screens inside the bot. */
export const useLoadState = () => useContext(LoadStateContext);

/**
 * Everything inside one bot (task 2.7): the canvas and the Variables screen share one store, so the
 * draft loads once, autosave keeps running while the builder moves between them, and a rename on
 * the Variables screen is already on the canvas when they go back.
 */
export function BotLayout({ workspaceId, botId }: { workspaceId: string; botId: string }) {
  const store = useMemo<CanvasStore>(() => createCanvasStore(), []);
  const [state, setState] = useState<LoadState>("loading");

  useEffect(() => {
    let saver: Saver | undefined;
    let cancelled = false;
    loadDraft(workspaceId, botId).then(
      (draft) => {
        if (cancelled) return;
        store.getState().load(draft);
        saver = createSaver({
          store,
          save: draftSaver(workspaceId, botId),
          timers: {
            setTimeout: (fn, ms) => window.setTimeout(fn, ms),
            clearTimeout: (h) => window.clearTimeout(h as number),
          },
        });
        setState("ready");
      },
      (error: unknown) => !cancelled && setState({ error }),
    );
    // Save anything pending when the screen closes.
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (
        store
          .getState()
          .docs()
          .some((d) => isDirty(d.state))
      ) {
        void saver?.flush();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", beforeUnload);
      void saver?.flush().finally(() => saver?.stop());
    };
  }, [store, workspaceId, botId]);

  return (
    <CanvasStoreContext.Provider value={store}>
      <LoadStateContext.Provider value={state}>
        <Outlet />
      </LoadStateContext.Provider>
    </CanvasStoreContext.Provider>
  );
}
