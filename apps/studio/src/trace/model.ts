import type { Span, Workflow } from "@wakeel/contracts";
import { describeError } from "../emulator/model";

/**
 * The emulator's trace (task 4.7, design system §5.3, ADR-026) as pure data: spans arrive over SSE
 * one at a time and again when they close; the list shows them as steps; the canvas tints what ran.
 */

/** Adds a span, or replaces the copy with the same id (a turn or node span that closed); seq order. */
export function mergeSpan(spans: readonly Span[], span: Span): Span[] {
  const rest = spans.filter((s) => s.id !== span.id);
  return [...rest, span].sort((a, b) => a.seq - b.seq);
}

export interface StepRow {
  span: Span;
  /** 0 for the turn, 1 for its nodes, and so on. */
  depth: number;
}

/** The trace list's rows: every span with its depth, in seq order. */
export function stepRows(spans: readonly Span[]): StepRow[] {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const depth = (s: Span): number => {
    let d = 0;
    let parent = s.parentId ? byId.get(s.parentId) : undefined;
    while (parent && d < 16) {
      d += 1;
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return d;
  };
  return [...spans].sort((a, b) => a.seq - b.seq).map((span) => ({ span, depth: depth(span) }));
}

/** What a step is called in the list (design system §3: a span is a "Step"). */
export function stepLabel(span: Span, names: { botName: string; cardNames: Record<string, string> }): string {
  switch (span.kind) {
    case "turn":
      return names.botName;
    case "card":
      return names.cardNames[span.attrs.cardType] ?? span.attrs.cardType;
    case "code.exec":
      return "Sandbox";
    case "error":
      return describeError(span.attrs.code, span.attrs.message).title;
    default:
      return span.name;
  }
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export interface RunOverlay {
  /** Cards that ran and did not fail: tinted, with a small check. */
  cards: ReadonlySet<string>;
  /** Cards that ran and failed: tinted, no check. */
  failed: ReadonlySet<string>;
  nodes: ReadonlySet<string>;
  /** Transitions the turn followed: drawn in the accent border colour. */
  edges: ReadonlySet<string>;
}

export const EMPTY_OVERLAY: RunOverlay = { cards: new Set(), failed: new Set(), nodes: new Set(), edges: new Set() };

/**
 * The canvas run overlay (§5.1 motion table, "Run overlay"): the cards and nodes a turn visited and
 * the transitions between consecutive nodes of one workflow. When the first node is where Start
 * leads, that transition counts too: the turn came in through it.
 */
export function runOverlay(spans: readonly Span[], workflows: Readonly<Record<string, Workflow>>): RunOverlay {
  const cards = new Set<string>();
  const failed = new Set<string>();
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const visits: { workflowId: string; nodeId: string }[] = [];
  for (const s of [...spans].sort((a, b) => a.seq - b.seq)) {
    const { workflowId, nodeId, cardId } = s.location;
    if (s.kind === "node" && workflowId && nodeId) {
      nodes.add(nodeId);
      visits.push({ workflowId, nodeId });
    }
    if (s.kind === "card" && cardId) (s.status === "error" ? failed : cards).add(cardId);
  }
  const edgeBetween = (wf: Workflow | undefined, from: string, to: string) =>
    wf?.edges.find((e) => e.from.nodeId === from && e.to.nodeId === to)?.id;
  const first = visits[0];
  if (first) {
    const wf = workflows[first.workflowId];
    const start = wf?.nodes.find((n) => n.type === "start");
    const id = start ? edgeBetween(wf, start.id, first.nodeId) : undefined;
    if (id) edges.add(id);
  }
  for (let i = 1; i < visits.length; i++) {
    const a = visits[i - 1];
    const b = visits[i];
    if (!a || !b || a.workflowId !== b.workflowId) continue;
    const id = edgeBetween(workflows[a.workflowId], a.nodeId, b.nodeId);
    if (id) edges.add(id);
  }
  return { cards, failed, nodes, edges };
}
