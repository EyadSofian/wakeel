import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { CanvasState, CanvasStore } from "./store/store";

/** The canvas store of the open bot, for every component inside the canvas screen. */
export const CanvasStoreContext = createContext<CanvasStore | null>(null);

export function useCanvasStore(): CanvasStore {
  const store = useContext(CanvasStoreContext);
  if (!store) throw new Error("useCanvas is used outside the canvas screen.");
  return store;
}

export function useCanvas<T>(selector: (s: CanvasState) => T): T {
  return useStore(useCanvasStore(), selector);
}
