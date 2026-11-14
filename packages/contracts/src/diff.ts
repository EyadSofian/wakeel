import { z } from "zod";
import type { BotDefinition } from "./bot-definition";
import { CardId, Json, NodeId, WorkflowId } from "./common";
import { PortId } from "./workflow";

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
 */
export function diffDefinitions(_before: BotDefinition, _after: BotDefinition): BotDiff {
  throw new Error("diffDefinitions is not implemented yet");
}
