import type { Workflow } from "@wakeel/contracts";

/**
 * Tidy layout (`⇧⌘L`, design system §5.1) and keyboard navigation geometry. Pure functions over the
 * document and measured node sizes; the canvas applies tidy through `commands.moveNodes`, so it is
 * one undo step and a layout-only change (ADR-006).
 */

export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

const DEFAULT_SIZE: Size = { width: 288, height: 120 };
/** Node width plus a 96 px gutter for transitions to curve in. */
const COLUMN_GAP = 96;
const ROW_GAP = 48;
const SNAP = 8;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

const ENTRY_TYPES = new Set(["start", "entry", "trigger", "error_handler"]);

/**
 * Columns by distance from the entry points (shortest path, so loops do not stretch the layout);
 * nodes no entry reaches, notes included, go in a last column. Within a column, nodes keep the
 * order they were reached in, which follows each node's output order, so branches read top-down.
 */
export function tidyLayout(
  wf: Workflow,
  sizes: ReadonlyMap<string, Size> = new Map(),
): Record<string, { x: number; y: number }> {
  const out = new Map<string, string[]>();
  for (const e of wf.edges) out.set(e.from.nodeId, [...(out.get(e.from.nodeId) ?? []), e.to.nodeId]);

  const rank = new Map<string, number>();
  const order: string[] = [];
  const queue: string[] = [];
  for (const n of wf.nodes) {
    if (ENTRY_TYPES.has(n.type)) {
      rank.set(n.id, 0);
      order.push(n.id);
      queue.push(n.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const next of out.get(id) ?? []) {
      if (rank.has(next)) continue;
      rank.set(next, (rank.get(id) ?? 0) + 1);
      order.push(next);
      queue.push(next);
    }
  }
  const last = Math.max(0, ...rank.values()) + 1;
  for (const n of wf.nodes) {
    if (!rank.has(n.id)) {
      rank.set(n.id, last);
      order.push(n.id);
    }
  }

  const columns = new Map<number, string[]>();
  for (const id of order) {
    const r = rank.get(id) ?? 0;
    columns.set(r, [...(columns.get(r) ?? []), id]);
  }
  const ranks = [...columns.keys()].sort((a, b) => a - b);
  const positions: Record<string, { x: number; y: number }> = {};
  let x = 0;
  for (const r of ranks) {
    const ids = columns.get(r) ?? [];
    let y = 0;
    let width = 0;
    for (const id of ids) {
      const size = sizes.get(id) ?? DEFAULT_SIZE;
      positions[id] = { x: snap(x), y: snap(y) };
      y += size.height + ROW_GAP;
      width = Math.max(width, size.width);
    }
    x += width + COLUMN_GAP;
  }
  return positions;
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * The node to move to from `from` with an arrow key: among nodes whose centre lies in that
 * direction, the one with the smallest distance along it plus twice the sideways offset, so a node
 * straight ahead beats a closer one off to the side.
 */
export function nearestInDirection(
  from: Rect,
  candidates: readonly { id: string; rect: Rect }[],
  dir: Direction,
): string | undefined {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  let best: { id: string; score: number } | undefined;
  for (const c of candidates) {
    const x = c.rect.x + c.rect.width / 2 - cx;
    const y = c.rect.y + c.rect.height / 2 - cy;
    const along = dir === "right" ? x : dir === "left" ? -x : dir === "down" ? y : -y;
    const across = dir === "left" || dir === "right" ? Math.abs(y) : Math.abs(x);
    if (along <= 0) continue;
    const score = along + 2 * across;
    if (!best || score < best.score) best = { id: c.id, score };
  }
  return best?.id;
}

/** Rough rendered height of a node from its rows, for fitting before anything is measured. */
export function estimateSize(node: Workflow["nodes"][number], rows: number): Size {
  const header = 72;
  const body = node.type === "standard" ? 16 + 36 + rows * 40 : node.type === "autonomous" ? 80 + rows * 32 : rows * 32;
  return { width: 288, height: header + body };
}

/**
 * The viewport that fits every node in a pane of `pane` size, never above `maxZoom` (design system
 * §5.1: a small workflow opens at its real size). Computed from the document, so the canvas can fit
 * before any node is rendered; xyflow then only renders what is on screen.
 */
export function fitViewport(
  wf: Workflow,
  sizes: ReadonlyMap<string, Size>,
  pane: Size,
  { padding = 0.2, maxZoom = 1, minZoom = 0.1 } = {},
): { x: number; y: number; zoom: number } {
  if (wf.nodes.length === 0 || pane.width === 0 || pane.height === 0) return { x: 0, y: 0, zoom: 1 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of wf.nodes) {
    const p = wf.layout[n.id] ?? { x: 0, y: 0 };
    const s = sizes.get(n.id) ?? DEFAULT_SIZE;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const zoom = Math.max(
    minZoom,
    Math.min(maxZoom, pane.width / (width * (1 + padding)), pane.height / (height * (1 + padding))),
  );
  return {
    x: pane.width / 2 - (minX + width / 2) * zoom,
    y: pane.height / 2 - (minY + height / 2) * zoom,
    zoom,
  };
}
