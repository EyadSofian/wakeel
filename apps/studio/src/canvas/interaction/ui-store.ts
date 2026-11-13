import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import { DRAWER } from "../../code/drawer-size";

/**
 * Canvas interaction state (task 2.5) that is not part of the document: open menus, the inline
 * rename, the keyboard cursor inside a node, keyboard connect mode, the node under a dragged
 * transition, and nodes added a moment ago (for their entrance). Kept apart from the document store
 * so undo never sees it, and read with selectors so a change re-renders only the nodes it names.
 */
export interface Port {
  nodeId: string;
  port: string;
}

export type Menu =
  /** The add-node menu at a screen point; with `from`, the new node is wired from that output. */
  | { kind: "node"; at: { x: number; y: number }; from?: Port }
  /** The card menu for a standard node, optionally pre-filtered (`/` inside a node). */
  | { kind: "card"; nodeId: string; at: { x: number; y: number }; query?: string };

export interface UiState {
  menu: Menu | undefined;
  /** Node whose name is being edited in place. */
  renaming: string | undefined;
  /** Keyboard cursor inside a node: a row index over its cards and outputs (`Enter` on a node). */
  cursor: { nodeId: string; row: number } | undefined;
  /** Keyboard connect or reconnect: the output, the node currently chosen, and the edge if reconnecting. */
  connecting: { from: Port; target: string | undefined; edgeId?: string } | undefined;
  /** Node under a transition being dragged: drawn as a valid target. */
  dropTarget: string | undefined;
  /** Nodes added moments ago; they play the entrance once. */
  fresh: ReadonlySet<string>;
  sheet: boolean;
  /** The Run code card open in the code drawer (task 2.9), in the open workflow. */
  code: { nodeId: string; cardId: string } | undefined;
  /** The drawer's height as a share of the canvas; kept while the screen is open. */
  codeShare: number;
  set(patch: Partial<Omit<UiState, "set" | "markFresh">>): void;
  markFresh(ids: readonly string[]): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(): UiStore {
  return createStore<UiState>((set) => ({
    menu: undefined,
    renaming: undefined,
    cursor: undefined,
    connecting: undefined,
    dropTarget: undefined,
    fresh: new Set(),
    sheet: false,
    code: undefined,
    codeShare: DRAWER.initial,
    set: (patch) => set(patch),
    markFresh: (ids) => set({ fresh: new Set(ids) }),
  }));
}

export const UiStoreContext = createContext<UiStore | null>(null);

export function useUiStore(): UiStore {
  const store = useContext(UiStoreContext);
  if (!store) throw new Error("useUi is used outside the canvas screen.");
  return store;
}

export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(useUiStore(), selector);
}
