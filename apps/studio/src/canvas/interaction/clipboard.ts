import {
  Edge,
  ELEMENT_PREFIXES,
  type ElementPrefix,
  Node,
  newElementId,
  Variable,
  type Workflow,
} from "@wakeel/contracts";
import { z } from "zod";

/**
 * Copy and paste of canvas nodes (design system §5.1: `⌘C` / `⌘V`, across workflows and bots).
 *
 * A fragment is the copied nodes, the transitions between them, their positions, and the
 * workflow-scope variables their cards reference (so a paste into another workflow keeps working).
 * On paste every element id inside the fragment (nodes, cards, branches, exits, tools, transitions)
 * is replaced with a new one, including inside port strings, so pasting twice never collides.
 * Ids of things outside the fragment (bot variables, workflows, knowledge bases, tables) are kept:
 * if they do not exist where the fragment lands, validation reports them like any other dangling
 * reference.
 */
export const FRAGMENT_KIND = "wakeel/canvas-fragment";

export const Fragment = z.object({
  kind: z.literal(FRAGMENT_KIND),
  version: z.literal(1),
  nodes: z.array(Node).min(1).max(300),
  edges: z.array(Edge).max(1_000),
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  variables: z.array(Variable).max(200),
});
export type Fragment = z.infer<typeof Fragment>;

/** Entry points are never copied: a workflow has exactly one. */
const COPYABLE = (n: Node) => n.type !== "start" && n.type !== "entry";

/** Element ids inside a node that a paste must replace. */
function elementIds(node: Node): string[] {
  const ids = [node.id];
  if (node.type === "standard") {
    for (const card of node.cards) {
      ids.push(card.id);
      if (card.type === "branch" || card.type === "ai_branch") ids.push(...card.branches.map((b) => b.id));
    }
  }
  if (node.type === "autonomous") {
    ids.push(...node.exits.map((e) => e.id), ...node.tools.map((t) => t.id));
  }
  return ids;
}

/** The fragment for `nodeIds` in `wf`, or undefined when nothing copyable is selected. */
export function copyFragment(wf: Workflow, nodeIds: readonly string[]): Fragment | undefined {
  const chosen = new Set(nodeIds);
  const nodes = wf.nodes.filter((n) => chosen.has(n.id) && COPYABLE(n));
  if (nodes.length === 0) return undefined;
  const kept = new Set(nodes.map((n) => n.id));
  const edges = wf.edges.filter((e) => kept.has(e.from.nodeId) && kept.has(e.to.nodeId));
  const layout = Object.fromEntries(nodes.map((n) => [n.id, wf.layout[n.id] ?? { x: 0, y: 0 }]));
  const text = JSON.stringify(nodes);
  const variables = wf.variables.filter((v) => text.includes(v.id));
  return { kind: FRAGMENT_KIND, version: 1, nodes, edges, layout, variables };
}

/** A fragment from clipboard text, or undefined if the text is not one (any other paste). */
export function parseFragment(text: string): Fragment | undefined {
  try {
    const parsed = Fragment.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const PREFIX = /^([a-z]+)_/;

/**
 * `wf` with the fragment added, its top-left corner at `at`, and the ids of the new nodes. Pure;
 * the canvas wraps it in a store command so a paste is one undo step.
 */
export function pasteFragment(
  wf: Workflow,
  fragment: Fragment,
  at: { x: number; y: number },
): { wf: Workflow; nodeIds: string[] } {
  const remap = new Map<string, string>();
  for (const node of fragment.nodes) {
    for (const id of elementIds(node)) {
      const prefix = PREFIX.exec(id)?.[1];
      if (prefix && (ELEMENT_PREFIXES as readonly string[]).includes(prefix))
        remap.set(id, newElementId(prefix as ElementPrefix));
    }
  }
  for (const edge of fragment.edges) remap.set(edge.id, newElementId("edge"));

  // Ids are random tokens that never appear inside other text, so a whole-token replace on the
  // serialised fragment updates them everywhere: ids, port strings, references between cards.
  const pattern = new RegExp([...remap.keys()].map((k) => k.replace(/[^A-Za-z0-9_]/g, "")).join("|"), "g");
  const swap = <T>(value: T, schema: z.ZodType<T>): T =>
    schema.parse(JSON.parse(JSON.stringify(value).replace(pattern, (m) => remap.get(m) ?? m)));

  const nodes = swap(fragment.nodes, z.array(Node));
  const edges = swap(fragment.edges, z.array(Edge));

  const xs = Object.values(fragment.layout).map((p) => p.x);
  const ys = Object.values(fragment.layout).map((p) => p.y);
  const origin = { x: Math.min(...xs), y: Math.min(...ys) };
  const layout = { ...wf.layout };
  for (const [oldId, pos] of Object.entries(fragment.layout)) {
    const id = remap.get(oldId);
    if (id) layout[id] = { x: at.x + pos.x - origin.x, y: at.y + pos.y - origin.y };
  }

  const known = new Set(wf.variables.map((v) => v.id));
  const names = new Set(wf.variables.map((v) => v.name));
  const variables = [...wf.variables];
  for (const v of fragment.variables) {
    if (known.has(v.id)) continue;
    // Same id is the same variable; a different variable with the same name gets a suffix.
    let name = v.name;
    for (let i = 2; names.has(name); i++) name = `${v.name.slice(0, 44)}_${i}`;
    names.add(name);
    variables.push({ ...v, name });
  }

  return {
    wf: { ...wf, nodes: [...wf.nodes, ...nodes], edges: [...wf.edges, ...edges], layout, variables },
    nodeIds: nodes.map((n) => n.id),
  };
}
