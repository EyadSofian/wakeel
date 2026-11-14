import type { Workflow } from "@wakeel/contracts";
import { useMotionTokens } from "@wakeel/ui";
import { useReactFlow } from "@xyflow/react";
import { type RefObject, useMemo } from "react";
import type { Action } from "../../shell/shell-store";
import { useCanvasStore } from "../context";
import { type Command, commands } from "../store/commands";
import type { CanvasRFNode } from "../view/CanvasNode";
import { FIT_VIEW } from "../view/viewport";
import { copyFragment } from "./clipboard";
import { tidyLayout } from "./layout";
import { SHORTCUTS } from "./shortcuts";
import { useUiStore } from "./ui-store";

const DUPLICATE_OFFSET = 32;

/**
 * What the canvas can do without a pointer gesture (task 2.8). The keyboard (`useCanvasKeyboard`)
 * and the command palette call the same functions, so a shortcut and its palette entry never drift
 * apart. Each returns false when it had nothing to act on.
 */
export interface CanvasActions {
  /** The add-node menu at a screen point, or at the centre of the canvas. */
  addNode(at?: { x: number; y: number }): boolean;
  /** The card menu of the one selected standard node. */
  addCard(query?: string): boolean;
  undo(): boolean;
  redo(): boolean;
  duplicate(): boolean;
  deleteSelection(): boolean;
  rename(): boolean;
  tidy(): boolean;
  fit(): boolean;
  zoomIn(): boolean;
  zoomOut(): boolean;
  zoom100(): boolean;
  selectTool(): boolean;
  panTool(): boolean;
  toggleMinimap(): boolean;
  shortcuts(): boolean;
}

export function useCanvasActions({
  region,
  run,
  setMinimap,
  setMode,
}: {
  region: RefObject<HTMLElement | null>;
  run: (command: Command) => boolean;
  setMinimap: (fn: (v: boolean) => boolean) => void;
  setMode: (mode: "hand" | "select") => void;
}): CanvasActions {
  const store = useCanvasStore();
  const ui = useUiStore();
  const flow = useReactFlow<CanvasRFNode>();
  // §5.1: keyboard zoom animates in duration.base, fit and jump in duration.slower; xyflow takes ms.
  const tokens = useMotionTokens();
  const zoomMs = tokens.reduced ? 0 : tokens.duration.base * 1000;
  const jumpMs = tokens.reduced ? 0 : tokens.duration.slower * 1000;

  return useMemo(() => {
    const workflow = (): Workflow | undefined => {
      const s = store.getState();
      return s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined;
    };
    const selected = () => store.getState().selection.nodeIds;
    const one = () => {
      const ids = selected();
      return ids.length === 1 ? workflow()?.nodes.find((n) => n.id === ids[0]) : undefined;
    };
    const centre = () => {
      const r = region.current?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
    };
    return {
      addNode(at) {
        ui.getState().set({ menu: { kind: "node", at: at ?? centre() } });
        return true;
      },
      addCard(query = "") {
        const node = one();
        if (node?.type !== "standard") return false;
        const button = region.current?.querySelector<HTMLElement>(`[data-add-card="${node.id}"]`);
        const r = button?.getBoundingClientRect();
        const at = r ? { x: r.left, y: r.bottom + 4 } : centre();
        ui.getState().set({ menu: { kind: "card", nodeId: node.id, at, query } });
        return true;
      },
      undo: () => store.getState().undo(),
      redo: () => store.getState().redo(),
      duplicate() {
        const wf = workflow();
        const fragment = wf ? copyFragment(wf, selected()) : undefined;
        if (!fragment) return false;
        const xs = Object.values(fragment.layout);
        const command = commands.paste(fragment, {
          x: Math.min(...xs.map((p) => p.x)) + DUPLICATE_OFFSET,
          y: Math.min(...xs.map((p) => p.y)) + DUPLICATE_OFFSET,
        });
        if (!run(command)) return false;
        ui.getState().markFresh(command.created);
        store.getState().select({ nodeIds: command.created, edgeIds: [], card: undefined });
        return true;
      },
      deleteSelection() {
        const wf = workflow();
        const s = store.getState().selection;
        // The one entry point of a workflow is never deleted (as on the canvas).
        const nodes = s.nodeIds.filter((id) => {
          const n = wf?.nodes.find((x) => x.id === id);
          return n !== undefined && n.type !== "start" && n.type !== "entry";
        });
        if (nodes.length === 0 && s.edgeIds.length === 0) return false;
        return run(commands.deleteSelection(nodes, s.edgeIds));
      },
      rename() {
        const node = one();
        if (!node) return false;
        ui.getState().set({ renaming: node.id });
        return true;
      },
      tidy() {
        const wf = workflow();
        if (!wf) return false;
        const sizes = new Map(
          flow.getNodes().map((n) => [n.id, { width: n.measured?.width ?? 288, height: n.measured?.height ?? 120 }]),
        );
        run({ ...commands.moveNodes(tidyLayout(wf, sizes)), label: "Tidy layout" });
        void flow.fitView({ ...FIT_VIEW, duration: jumpMs });
        return true;
      },
      fit() {
        void flow.fitView({ ...FIT_VIEW, duration: jumpMs });
        return true;
      },
      zoomIn() {
        void flow.zoomIn({ duration: zoomMs });
        return true;
      },
      zoomOut() {
        void flow.zoomOut({ duration: zoomMs });
        return true;
      },
      zoom100() {
        void flow.zoomTo(1, { duration: zoomMs });
        return true;
      },
      selectTool() {
        setMode("select");
        return true;
      },
      panTool() {
        setMode("hand");
        return true;
      },
      toggleMinimap() {
        setMinimap((v) => !v);
        return true;
      },
      shortcuts() {
        ui.getState().set({ sheet: true });
        return true;
      },
    };
  }, [store, ui, flow, region, run, setMinimap, setMode, zoomMs, jumpMs]);
}

const keysOf = (shortcut: string) => SHORTCUTS.find((s) => s.id === shortcut)?.keys;

/**
 * The canvas's palette entries (design system §5.15), each with the shortcut that does the same.
 * Labels follow the vocabulary (§3): one verb per action.
 */
export function canvasPaletteActions(act: CanvasActions, can: CanvasAvailability): Action[] {
  const entry = (
    id: string,
    label: string,
    shortcut: string,
    run: () => unknown,
    extra: Partial<Pick<Action, "keywords" | "unavailable">> = {},
  ): Action => {
    const keys = keysOf(shortcut);
    return { id, label, run, ...(keys ? { keys } : {}), ...extra };
  };
  return [
    entry("canvas.add-node", "Add node", "add-node", () => act.addNode()),
    entry("canvas.add-card", "Add card", "add-card", () => act.addCard(), {
      unavailable: () => (can.oneStandard() ? undefined : "Select a standard node first"),
    }),
    entry("canvas.undo", "Undo", "undo", () => act.undo(), {
      unavailable: () => (can.undo() ? undefined : "Nothing to undo"),
    }),
    entry("canvas.redo", "Redo", "redo", () => act.redo(), {
      unavailable: () => (can.redo() ? undefined : "Nothing to redo"),
    }),
    entry("canvas.duplicate", "Duplicate", "duplicate", () => act.duplicate(), {
      keywords: "copy nodes",
      unavailable: () => (can.copy() ? undefined : "Select a node first"),
    }),
    entry("canvas.delete", "Delete", "delete", () => act.deleteSelection(), {
      keywords: "remove nodes transitions",
      unavailable: () => (can.delete() ? undefined : "Select a node or transition first"),
    }),
    entry("canvas.rename", "Rename node", "rename", () => act.rename(), {
      unavailable: () => (can.one() ? undefined : "Select one node first"),
    }),
    entry("canvas.tidy", "Tidy layout", "tidy", () => act.tidy(), { keywords: "arrange auto layout" }),
    entry("canvas.fit", "Fit the workflow", "fit", () => act.fit(), { keywords: "zoom to fit view" }),
    entry("canvas.zoom-in", "Zoom in", "zoom-in", () => act.zoomIn()),
    entry("canvas.zoom-out", "Zoom out", "zoom-out", () => act.zoomOut()),
    entry("canvas.zoom-100", "Zoom to 100%", "zoom-100", () => act.zoom100(), { keywords: "actual size reset" }),
    entry("canvas.tool-select", "Select tool", "tool-select", () => act.selectTool()),
    entry("canvas.tool-pan", "Pan tool", "tool-pan", () => act.panTool(), { keywords: "hand" }),
    entry("canvas.minimap", "Show or hide the minimap", "minimap", () => act.toggleMinimap()),
    entry("canvas.shortcuts", "Show keyboard shortcuts", "sheet", () => act.shortcuts(), { keywords: "keys help" }),
  ];
}

/** What the palette asks before listing a canvas action as available. */
export interface CanvasAvailability {
  one(): boolean;
  oneStandard(): boolean;
  copy(): boolean;
  delete(): boolean;
  undo(): boolean;
  redo(): boolean;
}

/** Availability read from the store when the palette renders. */
export function useCanvasAvailability(): CanvasAvailability {
  const store = useCanvasStore();
  return useMemo(() => {
    const wf = () => {
      const s = store.getState();
      return s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined;
    };
    const nodes = () => {
      const ids = new Set(store.getState().selection.nodeIds);
      return (wf()?.nodes ?? []).filter((n) => ids.has(n.id));
    };
    const history = () => {
      const s = store.getState();
      return s.activeWorkflowId ? s.history[s.activeWorkflowId] : undefined;
    };
    return {
      one: () => nodes().length === 1,
      oneStandard: () => nodes().length === 1 && nodes()[0]?.type === "standard",
      copy: () => nodes().some((n) => n.type !== "start" && n.type !== "entry"),
      delete: () =>
        nodes().some((n) => n.type !== "start" && n.type !== "entry") || store.getState().selection.edgeIds.length > 0,
      undo: () => (history()?.past.length ?? 0) > 0,
      redo: () => (history()?.future.length ?? 0) > 0,
    };
  }, [store]);
}
