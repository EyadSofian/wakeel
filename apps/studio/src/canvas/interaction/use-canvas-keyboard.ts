import { NON_TARGETABLE_NODE_TYPES, type Workflow } from "@wakeel/contracts";
import { useMotionTokens } from "@wakeel/ui";
import { useReactFlow } from "@xyflow/react";
import { type RefObject, useEffect } from "react";
import { useCanvasStore } from "../context";
import { type Command, commands } from "../store/commands";
import type { CanvasRFNode } from "../view/CanvasNode";
import { FIT_VIEW } from "../view/viewport";
import { copyFragment, parseFragment } from "./clipboard";
import { type Direction, nearestInDirection, type Rect, tidyLayout } from "./layout";
import { nodeRows } from "./rows";
import { useUiStore } from "./ui-store";

/** Every shortcut id in shortcuts.ts that this handler implements (checked by a test). */
export const HANDLED = new Set([
  "pan",
  "zoom-in",
  "zoom-out",
  "fit",
  "zoom-100",
  "tool-select",
  "tool-pan",
  "minimap",
  "tidy",
  "undo",
  "redo",
  "sheet",
  "add-node",
  "next-node",
  "nearest",
  "enter",
  "leave",
  "move",
  "rename",
  "duplicate",
  "delete",
  "copy",
  "paste",
  "add-card",
  "card-search",
  "row",
  "reorder",
  "delete-card",
  "connect",
  "choose",
  "confirm",
  "reconnect",
]);

const ARROWS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};
const PAN_STEP = 48;
const DUPLICATE_OFFSET = 32;

/**
 * The canvas keyboard (design system §5.1 interaction table). Listens on the document because
 * clicking the empty pane leaves focus on <body>; acts only when focus is on the canvas or on
 * nothing, never inside a field, a menu or a dialog. Copy and paste use the browser's clipboard
 * events, so no clipboard permission is needed and pasting between bots and tabs works.
 */
export function useCanvasKeyboard({
  region,
  pointer,
  run,
  announce,
  setMinimap,
  setMode,
}: {
  region: RefObject<HTMLElement | null>;
  pointer: RefObject<{ x: number; y: number } | null>;
  run: (command: Command) => boolean;
  announce: (text: string) => void;
  setMinimap: (fn: (v: boolean) => boolean) => void;
  setMode: (mode: "hand" | "select") => void;
}) {
  const store = useCanvasStore();
  const ui = useUiStore();
  const flow = useReactFlow<CanvasRFNode>();
  // §5.1: keyboard zoom animates in duration.base, fit and jump in duration.slower; xyflow takes ms.
  const tokens = useMotionTokens();
  const zoomMs = tokens.reduced ? 0 : tokens.duration.base * 1000;
  const jumpMs = tokens.reduced ? 0 : tokens.duration.slower * 1000;

  useEffect(() => {
    const workflow = (): Workflow | undefined => {
      const s = store.getState();
      return s.activeWorkflowId ? s.workflows[s.activeWorkflowId]?.doc : undefined;
    };
    const rectOf = (id: string): Rect | undefined => {
      const n = flow.getNode(id);
      if (!n) return undefined;
      return { x: n.position.x, y: n.position.y, width: n.measured?.width ?? 288, height: n.measured?.height ?? 120 };
    };
    const onCanvas = (e: Event) => {
      const active = document.activeElement;
      if (active && active !== document.body && !region.current?.contains(active)) return false;
      const target = e.target as HTMLElement | null;
      return !target?.closest("input, textarea, select, [contenteditable], [role=dialog]");
    };
    const pointAt = () => {
      if (pointer.current) return pointer.current;
      const r = region.current?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
    };
    const reveal = (id: string) => {
      const r = rectOf(id);
      if (!r) return;
      const { x, y, zoom } = flow.getViewport();
      const pane = region.current?.getBoundingClientRect();
      if (!pane) return;
      const left = r.x * zoom + x;
      const top = r.y * zoom + y;
      const inside =
        left >= 0 && top >= 0 && left + r.width * zoom <= pane.width && top + r.height * zoom <= pane.height;
      if (!inside) void flow.setCenter(r.x + r.width / 2, r.y + r.height / 2, { zoom, duration: jumpMs });
    };
    const selectNode = (id: string) => {
      const wf = workflow();
      const node = wf?.nodes.find((n) => n.id === id);
      store.getState().select({ nodeIds: [id], edgeIds: [], card: undefined });
      ui.getState().set({ cursor: undefined });
      reveal(id);
      if (node) announce(`${node.name} selected`);
    };
    const targetable = (wf: Workflow, id: string, from: string) => {
      const n = wf.nodes.find((x) => x.id === id);
      return n !== undefined && id !== from && !NON_TARGETABLE_NODE_TYPES.includes(n.type);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const u = ui.getState();
      if (u.menu || u.renaming || e.defaultPrevented || !onCanvas(e)) return;
      if (u.sheet) {
        if (e.key === "Escape" || e.key === "?") {
          e.preventDefault();
          ui.getState().set({ sheet: false });
        }
        return;
      }
      const wf = workflow();
      if (!wf) return;
      const s = store.getState();
      const mod = e.metaKey || e.ctrlKey;
      const selected = s.selection.nodeIds;
      const one = selected.length === 1 ? wf.nodes.find((n) => n.id === selected[0]) : undefined;
      const handled = () => e.preventDefault();

      // Keyboard connect or reconnect: arrows choose the target, Enter connects, Esc cancels.
      if (u.connecting) {
        const c = u.connecting;
        const dir = ARROWS[e.key];
        if (dir) {
          handled();
          const from = rectOf(c.target ?? c.from.nodeId);
          if (!from) return;
          const candidates = wf.nodes
            .filter((n) => targetable(wf, n.id, c.from.nodeId))
            .flatMap((n) => {
              const rect = rectOf(n.id);
              return rect ? [{ id: n.id, rect }] : [];
            });
          const next = nearestInDirection(from, candidates, dir);
          if (next) {
            ui.getState().set({ connecting: { ...c, target: next } });
            reveal(next);
            announce(`Connect to ${wf.nodes.find((n) => n.id === next)?.name ?? ""}`);
          }
        } else if (e.key === "Enter") {
          handled();
          if (c.target) {
            run(c.edgeId ? commands.reconnect(c.edgeId, c.target) : commands.connect(c.from, c.target));
            announce("Connected");
          }
          ui.getState().set({ connecting: undefined });
        } else if (e.key === "Escape") {
          handled();
          ui.getState().set({ connecting: undefined });
          announce("Connection cancelled");
        }
        return;
      }

      if (mod) {
        const key = e.key.toLowerCase();
        if (key === "z") {
          handled();
          if (e.shiftKey) s.redo();
          else s.undo();
        } else if (key === "l" && e.shiftKey) {
          handled();
          const sizes = new Map(
            flow.getNodes().map((n) => [n.id, { width: n.measured?.width ?? 288, height: n.measured?.height ?? 120 }]),
          );
          run({ ...commands.moveNodes(tidyLayout(wf, sizes)), label: "Tidy layout" });
          void flow.fitView({ ...FIT_VIEW, duration: jumpMs });
        } else if (key === "d") {
          handled();
          const fragment = copyFragment(wf, selected);
          if (!fragment) return;
          const xs = Object.values(fragment.layout);
          const command = commands.paste(fragment, {
            x: Math.min(...xs.map((p) => p.x)) + DUPLICATE_OFFSET,
            y: Math.min(...xs.map((p) => p.y)) + DUPLICATE_OFFSET,
          });
          if (run(command)) {
            ui.getState().markFresh(command.created);
            store.getState().select({ nodeIds: command.created, edgeIds: [], card: undefined });
          }
        } else if (key === "=" || key === "+") {
          handled();
          void flow.zoomIn({ duration: zoomMs });
        } else if (key === "-" || key === "−") {
          handled();
          void flow.zoomOut({ duration: zoomMs });
        } else if (key === "0") {
          handled();
          void flow.fitView({ ...FIT_VIEW, duration: jumpMs });
        } else if (key === "1") {
          handled();
          void flow.zoomTo(1, { duration: zoomMs });
        }
        return;
      }

      const dir = ARROWS[e.key];

      // Inside a node: the cursor moves over cards and outputs.
      if (u.cursor) {
        const node = wf.nodes.find((n) => n.id === u.cursor?.nodeId);
        if (!node) {
          ui.getState().set({ cursor: undefined });
          return;
        }
        const rows = nodeRows(node);
        const row = rows[u.cursor.row];
        if (e.key === "Escape") {
          handled();
          ui.getState().set({ cursor: undefined });
          store.getState().select({ card: undefined });
          announce(`${node.name} selected`);
        } else if ((dir === "up" || dir === "down") && e.altKey) {
          handled();
          if (row?.kind !== "card" || node.type !== "standard") return;
          const index = node.cards.findIndex((c) => c.id === row.cardId);
          const to = index + (dir === "up" ? -1 : 1);
          if (to < 0 || to >= node.cards.length) return;
          if (run(commands.moveCard(node.id, row.cardId, to))) {
            const moved = workflow()?.nodes.find((n) => n.id === node.id);
            const at = moved ? nodeRows(moved).findIndex((r) => r.kind === "card" && r.cardId === row.cardId) : -1;
            ui.getState().set({ cursor: { nodeId: node.id, row: Math.max(0, at) } });
            announce(`Moved to position ${to + 1}`);
          }
        } else if (dir === "up" || dir === "down") {
          handled();
          const next = Math.max(0, Math.min(rows.length - 1, u.cursor.row + (dir === "up" ? -1 : 1)));
          const r = rows[next];
          ui.getState().set({ cursor: { nodeId: node.id, row: next } });
          store.getState().select({ card: r?.kind === "card" ? { nodeId: node.id, cardId: r.cardId } : undefined });
          announce(r?.kind === "output" ? `Output ${r.label}` : "Card");
        } else if (e.key === "Enter") {
          handled();
          if (row?.kind === "output") {
            const existing = wf.edges.find((x) => x.from.nodeId === node.id && x.from.port === row.port);
            ui.getState().set({
              connecting: { from: { nodeId: node.id, port: row.port }, target: existing?.to.nodeId },
            });
            announce(`Choose a node to connect ${row.label} to, with the arrow keys`);
          }
        } else if (e.key === "Backspace" || e.key === "Delete") {
          handled();
          if (row?.kind === "card" && run(commands.deleteCard(node.id, row.cardId))) {
            const left = workflow()?.nodes.find((n) => n.id === node.id);
            const count = left ? nodeRows(left).length : 0;
            ui.getState().set({
              cursor: count > 0 ? { nodeId: node.id, row: Math.min(u.cursor.row, count - 1) } : undefined,
            });
            announce("Card deleted");
          }
        } else if (e.key === "/" && node.type === "standard") {
          handled();
          openCardMenu(node.id, "");
        }
        return;
      }

      if (e.key === "Escape") {
        // Up one level: from a card to its node, then from the node to nothing.
        if (s.selection.card) {
          handled();
          store.getState().select({ card: undefined });
        } else if (selected.length > 0 || s.selection.edgeIds.length > 0) {
          handled();
          store.getState().clearSelection();
        }
      } else if (e.key === "Tab") {
        handled();
        const order = wf.nodes;
        if (order.length === 0) return;
        const at = one ? order.findIndex((n) => n.id === one.id) : -1;
        const next = order[(at + (e.shiftKey ? -1 : 1) + order.length) % order.length];
        if (next) selectNode(next.id);
      } else if (e.key === "Enter" && one) {
        handled();
        if (nodeRows(one).length > 0) {
          const first = nodeRows(one)[0];
          ui.getState().set({ cursor: { nodeId: one.id, row: 0 } });
          store
            .getState()
            .select({ card: first?.kind === "card" ? { nodeId: one.id, cardId: first.cardId } : undefined });
          announce(`Inside ${one.name}`);
        } else {
          ui.getState().set({ renaming: one.id });
        }
      } else if (e.key === "F2" && one) {
        handled();
        ui.getState().set({ renaming: one.id });
      } else if (dir && e.shiftKey && selected.length > 0) {
        handled();
        const step = e.altKey ? 1 : 8;
        const dx = dir === "left" ? -step : dir === "right" ? step : 0;
        const dy = dir === "up" ? -step : dir === "down" ? step : 0;
        run(
          commands.moveNodes(
            Object.fromEntries(
              selected.map((id) => {
                const p = wf.layout[id] ?? { x: 0, y: 0 };
                return [id, { x: p.x + dx, y: p.y + dy }];
              }),
            ),
          ),
        );
      } else if (dir && one) {
        handled();
        const from = rectOf(one.id);
        if (!from) return;
        const candidates = wf.nodes.flatMap((n) => {
          const rect = n.id === one.id ? undefined : rectOf(n.id);
          return rect ? [{ id: n.id, rect }] : [];
        });
        const next = nearestInDirection(from, candidates, dir);
        if (next) selectNode(next);
      } else if (dir && selected.length === 0) {
        handled();
        const { x, y, zoom } = flow.getViewport();
        const dx = dir === "left" ? PAN_STEP : dir === "right" ? -PAN_STEP : 0;
        const dy = dir === "up" ? PAN_STEP : dir === "down" ? -PAN_STEP : 0;
        void flow.setViewport({ x: x + dx, y: y + dy, zoom });
      } else if (e.key === "n" && !e.altKey) {
        handled();
        ui.getState().set({ menu: { kind: "node", at: pointAt() } });
      } else if (e.key === "c" && one?.type === "standard") {
        handled();
        openCardMenu(one.id, "");
      } else if (e.key === "/" && one?.type === "standard") {
        handled();
        openCardMenu(one.id, "");
      } else if (e.key === "r" && s.selection.edgeIds.length === 1) {
        handled();
        const edge = wf.edges.find((x) => x.id === s.selection.edgeIds[0]);
        if (edge) {
          ui.getState().set({ connecting: { from: edge.from, target: edge.to.nodeId, edgeId: edge.id } });
          announce("Choose the new target with the arrow keys");
        }
      } else if (e.key === "m") {
        handled();
        setMinimap((v) => !v);
      } else if (e.key === "v") {
        handled();
        setMode("select");
      } else if (e.key === "h") {
        handled();
        setMode("hand");
      } else if (e.key === "?") {
        handled();
        ui.getState().set({ sheet: true });
      }
    };

    /** The card menu below the node's "Add card" button, or at the node's centre. */
    const openCardMenu = (nodeId: string, query: string) => {
      const button = region.current?.querySelector<HTMLElement>(`[data-add-card="${nodeId}"]`);
      const r = button?.getBoundingClientRect();
      const at = r ? { x: r.left, y: r.bottom + 4 } : pointAt();
      ui.getState().set({ menu: { kind: "card", nodeId, at, query } });
    };

    const onCopy = (e: ClipboardEvent) => {
      if (!onCanvas(e) || window.getSelection()?.toString()) return;
      const wf = workflow();
      const fragment = wf ? copyFragment(wf, store.getState().selection.nodeIds) : undefined;
      if (!fragment || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", JSON.stringify(fragment));
      announce(`Copied ${fragment.nodes.length === 1 ? "1 node" : `${fragment.nodes.length} nodes`}`);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!onCanvas(e)) return;
      const fragment = parseFragment(e.clipboardData?.getData("text/plain") ?? "");
      if (!fragment) return;
      e.preventDefault();
      const p = flow.screenToFlowPosition(pointAt());
      const command = commands.paste(fragment, { x: Math.round(p.x / 8) * 8, y: Math.round(p.y / 8) * 8 });
      if (run(command)) {
        ui.getState().markFresh(command.created);
        store.getState().select({ nodeIds: command.created, edgeIds: [], card: undefined });
        announce(`Pasted ${command.created.length === 1 ? "1 node" : `${command.created.length} nodes`}`);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [store, ui, flow, region, pointer, run, announce, setMinimap, setMode, zoomMs, jumpMs]);
}
