import {
  type BotDefinition,
  ELEMENT_PREFIXES,
  type ElementPrefix,
  findUsages,
  newElementId,
  type ReferenceUsage,
  Workflow,
} from "@wakeel/contracts";
import { CARD_NAMES } from "../canvas/view/summaries";

/**
 * The Workflows panel's logic (task 2.8), kept pure so it is tested without a screen: the copy a
 * duplicate becomes, the name it gets, and where a workflow is called from.
 */

const NAME_MAX = 80;

/** "Refunds copy", then "Refunds copy 2"…, never longer than a display name may be. */
export function copyName(name: string, taken: readonly string[]): string {
  const used = new Set(taken);
  const base = `${name.slice(0, NAME_MAX - " copy 99".length)} copy`;
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const next = `${base} ${i}`;
    if (!used.has(next)) return next;
  }
}

const PREFIX = /^([a-z]+)_/;

/** Every element id a workflow defines (nodes, cards, branches, exits, tools, transitions, its variables). */
function definedIds(wf: Workflow): string[] {
  const ids = [...wf.variables.map((v) => v.id), ...wf.edges.map((e) => e.id)];
  for (const node of wf.nodes) {
    ids.push(node.id);
    if (node.type === "standard") {
      for (const card of node.cards) {
        ids.push(card.id);
        if (card.type === "branch" || card.type === "ai_branch") ids.push(...card.branches.map((b) => b.id));
      }
    }
    if (node.type === "autonomous") ids.push(...node.exits.map((e) => e.id), ...node.tools.map((t) => t.id));
  }
  return ids;
}

/**
 * `source` copied into the document the server created for the duplicate (`target`: its id and
 * name). Ids inside a bot are unique (architecture §2.2), so every element the source defines gets
 * a new id, everywhere it appears: port strings, layout keys, cards that store into its variables.
 * Ids of things outside it (bot variables, other workflows, knowledge bases) are kept.
 */
export function duplicateWorkflow(source: Workflow, target: { id: string; name: string }): Workflow {
  const remap = new Map<string, string>([[source.id, target.id]]);
  for (const id of definedIds(source)) {
    const prefix = PREFIX.exec(id)?.[1];
    if (prefix && (ELEMENT_PREFIXES as readonly string[]).includes(prefix))
      remap.set(id, newElementId(prefix as ElementPrefix));
  }
  // Ids are random tokens that never occur inside other text, so replacing whole tokens in the
  // serialised document updates them everywhere at once (the same approach as paste).
  const pattern = new RegExp(`\\b(${[...remap.keys()].join("|")})\\b`, "g");
  const text = JSON.stringify(source).replace(pattern, (m) => remap.get(m) ?? m);
  return Workflow.parse({ ...JSON.parse(text), id: target.id, name: target.name });
}

/** One place that calls a workflow, worded for the delete warning. */
export interface CallSite {
  usage: ReferenceUsage;
  workflow: string;
  node: string;
  /** "Run workflow card" or "Workflow tool lookup". */
  what: string;
}

/** Run workflow cards and workflow tools that call `workflowId`, in workflow and node order. */
export function callSites(def: Pick<BotDefinition, "manifest" | "workflows">, workflowId: string): CallSite[] {
  return findUsages(def, { kind: "workflow", workflowId }).flatMap((usage) => {
    const wf = def.workflows.find((w) => w.id === usage.workflowId);
    const node = wf?.nodes.find((n) => n.id === usage.nodeId);
    if (!wf || !node) return [];
    let what = `${CARD_NAMES.call_workflow} card`;
    if (node.type === "autonomous") {
      const index = Number(/^tools\[(\d+)\]/.exec(usage.field)?.[1] ?? -1);
      what = `Workflow tool ${node.tools[index]?.name ?? ""}`.trim();
    }
    return [{ usage, workflow: wf.name, node: node.name, what }];
  });
}

/** Why a workflow cannot be deleted, or undefined when it can. */
export function deleteBlocker(wf: Workflow): string | undefined {
  return wf.kind === "main" ? "The main workflow is where conversations start, so it cannot be deleted." : undefined;
}

/** Why a workflow cannot be duplicated, or undefined when it can. */
export function duplicateBlocker(wf: Workflow): string | undefined {
  if (wf.kind === "main") return "A bot has one main workflow. Duplicate a sub-workflow instead.";
  if (wf.kind === "error") return "A bot has one error workflow. Duplicate a sub-workflow instead.";
  return undefined;
}
