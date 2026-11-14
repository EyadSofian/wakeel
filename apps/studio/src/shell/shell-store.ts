import type { DefinitionIssue } from "@wakeel/contracts";
import { createContext, useContext, useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

/**
 * State of the bot shell (task 2.8) that outlives one screen: the command palette, the Issues
 * panel, the workflow dialogs, a pending "reveal and focus" for the canvas, and the actions screens
 * register for the palette. The canvas and the Variables screen both sit inside it.
 */

/** Something the palette can run (design system §5.15 "Actions"). */
export interface Action {
  id: string;
  label: string;
  /** Keys as the shortcut sheet shows them: ["⇧", "⌘", "L"]. */
  keys?: readonly string[];
  /** Other words that should find it: "fit" also finds "Fit the workflow". */
  keywords?: string;
  /** Why it cannot run right now, read when the palette lists it; undefined when it can. */
  unavailable?: () => string | undefined;
  run(): void;
}

export type WorkflowDialog =
  | { kind: "new" }
  | { kind: "rename"; workflowId: string }
  | { kind: "delete"; workflowId: string }
  /** A request with no dialog of its own failed (Duplicate): what happened and the fix. */
  | { kind: "failed"; title: string; error: unknown };

/** Reveal a node on the canvas and focus it, or the inspector field at `path` (issues, palette). */
export interface FocusRequest {
  nodeId: string;
  path?: string;
  seq: number;
}

export interface ShellState {
  palette: boolean;
  issuesPanel: boolean;
  dialog: WorkflowDialog | undefined;
  /** The issue `F8` last jumped to, as `code:path`, so the next press continues from it. */
  issueAt: string | undefined;
  focus: FocusRequest | undefined;
  /** Registered actions by source ("shell", "canvas"); a screen's actions leave with it. */
  sources: Readonly<Record<string, readonly Action[]>>;
  set(patch: Partial<Pick<ShellState, "palette" | "issuesPanel" | "dialog" | "issueAt" | "focus">>): void;
  requestFocus(target: { nodeId: string; path?: string }): void;
  register(source: string, actions: readonly Action[]): () => void;
}

export type ShellStore = StoreApi<ShellState>;

export function createShellStore(): ShellStore {
  let seq = 0;
  return createStore<ShellState>((set, get) => ({
    palette: false,
    issuesPanel: false,
    dialog: undefined,
    issueAt: undefined,
    focus: undefined,
    sources: {},
    set: (patch) => set(patch),
    requestFocus: (target) => {
      seq += 1;
      set({ focus: { ...target, seq } });
    },
    register: (source, actions) => {
      set({ sources: { ...get().sources, [source]: actions } });
      return () => {
        // Only remove what this registration put there; a newer one for the same source stays.
        if (get().sources[source] !== actions) return;
        const { [source]: _gone, ...rest } = get().sources;
        set({ sources: rest });
      };
    },
  }));
}

/** What the builder works on comes first: the canvas's actions, then the shell's, then the rest. */
const SOURCE_ORDER = ["canvas", "shell"];

/** Every registered action, the screen's first. */
export const allActions = (s: Pick<ShellState, "sources">): Action[] => {
  const rank = (k: string) => (SOURCE_ORDER.includes(k) ? SOURCE_ORDER.indexOf(k) : SOURCE_ORDER.length);
  return Object.keys(s.sources)
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((k) => s.sources[k] ?? []);
};

export interface Shell {
  store: ShellStore;
  workspaceId: string;
  botId: string;
  /** Validation result for the whole draft, or undefined until the first one arrives. */
  issues: DefinitionIssue[] | undefined;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell is used outside a bot.");
  return shell;
}

export function useShellState<T>(selector: (s: ShellState) => T): T {
  return useStore(useShell().store, selector);
}

/** Registers `actions` for the palette while the calling component is mounted. Memoise the list. */
export function useRegisterActions(source: string, actions: readonly Action[]): void {
  const { store } = useShell();
  useEffect(() => store.getState().register(source, actions), [store, source, actions]);
}
