import { z } from "zod";
import type { BotDefinition } from "./bot-definition";
import type { Card } from "./card";
import { CardId, Json, NodeId, WorkflowId } from "./common";
import type { Node } from "./node";
import { type Edge, PortId, type Workflow } from "./workflow";

/*
 * Structural diff between two bot definitions (build plan 7.4, design system §5.8).
 *
 * The hierarchy is workflow → node → card → field. Canvas layout (`workflow.layout`)
 * is never compared, so moving nodes produces no diff (architecture §3, ADR-006).
 * Elements are matched by their stable ids, so a rename is a change, not a remove
 * and an add. Edges are matched by their source port, because a node port has at
 * most one transition; an edge that only got a new id is not a change.
 */

export const DiffChange = z.enum(["added", "removed", "changed"]);
export type DiffChange = z.infer<typeof DiffChange>;

/**
 * Where a field sits inside its element. A number indexes a plain list. A string
 * either names an object key or, inside a list of elements that carry an `id`,
 * `key` or `name` (tools, exits, variables, config variables, workflow inputs),
 * names the element by that key, so reordering such a list does not shift paths.
 */
export const DiffPath = z.array(z.union([z.string(), z.number().int().nonnegative()]));
export type DiffPath = z.infer<typeof DiffPath>;

/**
 * One changed value. `before` is absent when the field was added, `after` when it was
 * removed. When a keyed list only changed order, a single entry at the list's own path
 * holds the element keys in their old and new order.
 */
export const FieldDiff = z.object({
  path: DiffPath,
  before: Json.optional(),
  after: Json.optional(),
});
export type FieldDiff = z.infer<typeof FieldDiff>;

/** Positions in the node's card list, set when a card changed place within its node. */
export const CardMove = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});
export type CardMove = z.infer<typeof CardMove>;

/**
 * A card that was added, removed or changed. Added and removed cards carry no fields:
 * the whole card is new or gone. A card that moved to another node appears as removed
 * from the old node and added to the new one.
 */
export const CardDiff = z.object({
  cardId: CardId,
  /** The card type after the change, or before it for a removed card. */
  cardType: z.string(),
  change: DiffChange,
  moved: CardMove.optional(),
  fields: z.array(FieldDiff),
});
export type CardDiff = z.infer<typeof CardDiff>;

/**
 * A node that was added, removed or changed. `fields` covers everything on the node
 * except its id and cards; `cards` lists the cards that differ. The cards of an added
 * or removed node are all listed as added or removed.
 */
export const NodeDiff = z.object({
  nodeId: NodeId,
  /** The node type after the change, or before it for a removed node. */
  nodeType: z.string(),
  change: DiffChange,
  fields: z.array(FieldDiff),
  cards: z.array(CardDiff),
});
export type NodeDiff = z.infer<typeof NodeDiff>;

/** A transition, identified by the node port it leaves from. */
export const EdgeDiff = z.object({
  from: z.object({ nodeId: NodeId, port: PortId }),
  change: DiffChange,
  /** Target node before the change; absent for an added edge. */
  toBefore: NodeId.optional(),
  /** Target node after the change; absent for a removed edge. */
  toAfter: NodeId.optional(),
});
export type EdgeDiff = z.infer<typeof EdgeDiff>;

/**
 * A workflow that was added, removed or changed. `fields` covers name, description,
 * kind, inputs, outputs and variables; nodes and edges are listed separately; layout
 * is ignored. The nodes and edges of an added or removed workflow are all listed.
 */
export const WorkflowDiff = z.object({
  workflowId: WorkflowId,
  change: DiffChange,
  fields: z.array(FieldDiff),
  nodes: z.array(NodeDiff),
  edges: z.array(EdgeDiff),
});
export type WorkflowDiff = z.infer<typeof WorkflowDiff>;

export const DiffCounts = z.object({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
});
export type DiffCounts = z.infer<typeof DiffCounts>;

/** Counts for the publish dialog's summary of changes. A moved card counts as changed. */
export const DiffSummary = z.object({
  workflows: DiffCounts,
  nodes: DiffCounts,
  cards: DiffCounts,
  edges: DiffCounts,
  /** Number of changed manifest fields (settings, variables, config variables and the rest). */
  manifestFields: z.number().int().nonnegative(),
});
export type DiffSummary = z.infer<typeof DiffSummary>;

export const BotDiff = z.object({
  /** False when the two definitions behave the same; layout-only edits leave it false. */
  hasChanges: z.boolean(),
  /** Changed manifest fields, with paths from the manifest root (`["settings", "models", "default"]`). */
  manifest: z.array(FieldDiff),
  /** Only workflows that differ, in the new definition's order with removed ones next to their old neighbours. */
  workflows: z.array(WorkflowDiff),
  summary: DiffSummary,
});
export type BotDiff = z.infer<typeof BotDiff>;

/**
 * Compares two parsed bot definitions and returns what changed from `before` to `after`.
 * Both inputs must be parsed with `BotDefinition` so that defaults are filled in;
 * otherwise an omitted default and its explicit value would show as a change.
 * Text is compared exactly, with no normalisation: a change of diacritics or digit
 * script is a change.
 */
export function diffDefinitions(before: BotDefinition, after: BotDefinition): BotDiff {
  const manifest: FieldDiff[] = [];
  diffValues(before.manifest, after.manifest, [], manifest);

  const beforeWfs = byId(before.workflows);
  const afterWfs = byId(after.workflows);
  const workflows: WorkflowDiff[] = [];
  for (const id of mergeOrder([...beforeWfs.keys()], [...afterWfs.keys()])) {
    const d = diffWorkflow(beforeWfs.get(id), afterWfs.get(id));
    if (d) workflows.push(d);
  }

  return {
    hasChanges: manifest.length > 0 || workflows.length > 0,
    manifest,
    workflows,
    summary: summarise(manifest, workflows),
  };
}

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

function diffWorkflow(before: Workflow | undefined, after: Workflow | undefined): WorkflowDiff | undefined {
  const workflowId = (after ?? before)?.id;
  if (!workflowId) return undefined;
  const change: DiffChange = !before ? "added" : !after ? "removed" : "changed";

  const fields: FieldDiff[] = [];
  if (before && after) {
    diffValues(omit(before, WORKFLOW_ELEMENT_KEYS), omit(after, WORKFLOW_ELEMENT_KEYS), [], fields);
  }

  const beforeNodes = byId(before?.nodes ?? []);
  const afterNodes = byId(after?.nodes ?? []);
  const nodes: NodeDiff[] = [];
  for (const id of mergeOrder([...beforeNodes.keys()], [...afterNodes.keys()])) {
    const d = diffNode(beforeNodes.get(id), afterNodes.get(id));
    if (d) nodes.push(d);
  }

  const edges = diffEdges(before?.edges ?? [], after?.edges ?? []);

  if (change === "changed" && fields.length === 0 && nodes.length === 0 && edges.length === 0) return undefined;
  return { workflowId, change, fields, nodes, edges };
}

/** Workflow keys that are compared as elements of their own, or not at all (layout). */
const WORKFLOW_ELEMENT_KEYS = ["id", "nodes", "edges", "layout"] as const;
/** Node keys that are not compared as node fields. */
const NODE_ELEMENT_KEYS = ["id", "cards"] as const;

function diffNode(before: Node | undefined, after: Node | undefined): NodeDiff | undefined {
  const node = after ?? before;
  if (!node) return undefined;
  if (!before || !after) {
    const change: DiffChange = before ? "removed" : "added";
    return {
      nodeId: node.id,
      nodeType: node.type,
      change,
      fields: [],
      cards: nodeCards(node).map((c) => ({ cardId: c.id, cardType: c.type, change, fields: [] })),
    };
  }
  const fields: FieldDiff[] = [];
  diffValues(omit(before, NODE_ELEMENT_KEYS), omit(after, NODE_ELEMENT_KEYS), [], fields);
  const cards = diffCards(nodeCards(before), nodeCards(after));
  if (fields.length === 0 && cards.length === 0) return undefined;
  return { nodeId: after.id, nodeType: after.type, change: "changed", fields, cards };
}

function nodeCards(node: Node): Card[] {
  return node.type === "standard" ? node.cards : [];
}

/** Cards run top to bottom, so their order within a node is logic and is reported as moves. */
function diffCards(before: Card[], after: Card[]): CardDiff[] {
  const beforeIds = before.map((c) => c.id);
  const afterIds = after.map((c) => c.id);
  const beforeCards = byId(before);
  const afterCards = byId(after);
  const moved = outOfOrder(beforeIds, afterIds);

  const out: CardDiff[] = [];
  for (const id of mergeOrder(beforeIds, afterIds)) {
    const b = beforeCards.get(id);
    const a = afterCards.get(id);
    if (!b && a) out.push({ cardId: id, cardType: a.type, change: "added", fields: [] });
    else if (b && !a) out.push({ cardId: id, cardType: b.type, change: "removed", fields: [] });
    else if (b && a) {
      const fields: FieldDiff[] = [];
      diffValues(omit(b, ["id"]), omit(a, ["id"]), [], fields);
      const isMoved = moved.has(id);
      if (fields.length === 0 && !isMoved) continue;
      const d: CardDiff = { cardId: id, cardType: a.type, change: "changed", fields };
      if (isMoved) d.moved = { from: beforeIds.indexOf(id), to: afterIds.indexOf(id) };
      out.push(d);
    }
  }
  return out;
}

/**
 * Edges are keyed by source port because a port has one transition; the edge id is not
 * logic. A second edge on the same port (an invalid draft) is keyed by its id as well,
 * so it is still reported rather than lost.
 */
function diffEdges(before: Edge[], after: Edge[]): EdgeDiff[] {
  const beforeEdges = byPort(before);
  const afterEdges = byPort(after);
  const out: EdgeDiff[] = [];
  for (const key of mergeOrder([...beforeEdges.keys()], [...afterEdges.keys()])) {
    const b = beforeEdges.get(key);
    const a = afterEdges.get(key);
    if (!b && a) out.push({ from: { ...a.from }, change: "added", toAfter: a.to.nodeId });
    else if (b && !a) out.push({ from: { ...b.from }, change: "removed", toBefore: b.to.nodeId });
    else if (b && a && b.to.nodeId !== a.to.nodeId) {
      out.push({ from: { ...a.from }, change: "changed", toBefore: b.to.nodeId, toAfter: a.to.nodeId });
    }
  }
  return out;
}

function byPort(edges: Edge[]): Map<string, Edge> {
  const map = new Map<string, Edge>();
  for (const e of edges) {
    const key = `${e.from.nodeId} ${e.from.port}`;
    map.set(map.has(key) ? `${key} ${e.id}` : key, e);
  }
  return map;
}

function summarise(manifest: FieldDiff[], workflows: WorkflowDiff[]): DiffSummary {
  const counts = () => ({ added: 0, removed: 0, changed: 0 });
  const summary: DiffSummary = {
    workflows: counts(),
    nodes: counts(),
    cards: counts(),
    edges: counts(),
    manifestFields: manifest.length,
  };
  for (const wf of workflows) {
    summary.workflows[wf.change] += 1;
    for (const node of wf.nodes) {
      summary.nodes[node.change] += 1;
      for (const card of node.cards) summary.cards[card.change] += 1;
    }
    for (const edge of wf.edges) summary.edges[edge.change] += 1;
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** Appends the differences between two values, found by walking them in step, to `out`. */
function diffValues(before: unknown, after: unknown, path: DiffPath, out: FieldDiff[]): void {
  if (equal(before, after)) return;
  if (isPlain(before) && isPlain(after)) {
    for (const key of mergeOrder(Object.keys(before), Object.keys(after))) {
      diffValues(before[key], after[key], [...path, key], out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const key = listKey(before, after);
    if (key) {
      diffKeyedList(before as Plain[], after as Plain[], key, path, out);
      return;
    }
    if ([...before, ...after].every(isPlain)) {
      for (let i = 0; i < Math.max(before.length, after.length); i++) {
        diffValues(before[i], after[i], [...path, i], out);
      }
      return;
    }
  }
  // A plain value, a list of plain values, or a value that changed kind: one field, whole.
  const field: FieldDiff = { path };
  if (before !== undefined) field.before = asJson(before);
  if (after !== undefined) field.after = asJson(after);
  out.push(field);
}

/** Element keys tried in order; the first one every element has, uniquely per side, is used. */
const LIST_KEYS = ["id", "key", "name"] as const;

function listKey(before: unknown[], after: unknown[]): string | undefined {
  const all = [...before, ...after];
  if (all.length === 0 || !all.every(isPlain)) return undefined;
  const elements = all as Plain[];
  const unique = (list: unknown[], key: string) => new Set(list.map((e) => (e as Plain)[key])).size === list.length;
  return LIST_KEYS.find(
    (key) => elements.every((e) => typeof e[key] === "string") && unique(before, key) && unique(after, key),
  );
}

function diffKeyedList(before: Plain[], after: Plain[], key: string, path: DiffPath, out: FieldDiff[]): void {
  const beforeKeys = before.map((e) => e[key] as string);
  const afterKeys = after.map((e) => e[key] as string);
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);
  const keptBefore = beforeKeys.filter((k) => afterSet.has(k));
  const keptAfter = afterKeys.filter((k) => beforeSet.has(k));
  if (keptBefore.some((k, i) => k !== keptAfter[i])) out.push({ path, before: beforeKeys, after: afterKeys });

  const beforeByKey = new Map(before.map((e) => [e[key] as string, e]));
  const afterByKey = new Map(after.map((e) => [e[key] as string, e]));
  for (const k of mergeOrder(beforeKeys, afterKeys)) {
    diffValues(beforeByKey.get(k), afterByKey.get(k), [...path, k], out);
  }
}

/** Deep equality of JSON values; a property set to `undefined` counts as absent. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (!isPlain(a) || !isPlain(b)) return false;
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  return keysA.length === keysB.length && keysA.every((k) => equal(a[k], b[k]));
}

/** A copy, so the diff never shares objects with the definitions it was built from. */
function asJson(value: unknown): Json {
  // Parsed definitions hold only JSON values, so the copy is JSON too.
  return structuredClone(value) as Json;
}

/* ------------------------------------------------------------------ */
/* Ordering                                                            */
/* ------------------------------------------------------------------ */

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function omit(value: object, keys: readonly string[]): Plain {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
}

/**
 * The union of two key lists in `after` order, with each key found only in `before`
 * placed right after the key that preceded it there, so removed items sit next to
 * their old neighbours.
 */
function mergeOrder(before: readonly string[], after: readonly string[]): string[] {
  const inAfter = new Set(after);
  const following = new Map<string | undefined, string[]>();
  let previous: string | undefined;
  for (const key of before) {
    if (inAfter.has(key)) {
      previous = key;
      continue;
    }
    const list = following.get(previous) ?? [];
    list.push(key);
    following.set(previous, list);
  }
  const out = [...(following.get(undefined) ?? [])];
  for (const key of after) {
    out.push(key, ...(following.get(key) ?? []));
  }
  return out;
}

/**
 * Ids present in both lists whose relative order changed: those outside a longest
 * common subsequence. Moving one card therefore marks that card only, not every card
 * it passed.
 */
function outOfOrder(before: readonly string[], after: readonly string[]): Set<string> {
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  const a = before.filter((id) => afterSet.has(id));
  const b = after.filter((id) => beforeSet.has(id));
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const kept = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(a[i] as string);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return new Set(a.filter((id) => !kept.has(id)));
}
