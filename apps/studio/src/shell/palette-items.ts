import type { BotManifest, Workflow } from "@wakeel/contracts";
import { CARD_NAMES, NODE_TYPE_LABELS, summarizeCard } from "../canvas/view/summaries";
import { orderWorkflows } from "../routes/variables/model";

/**
 * The palette's "Go to" entries (design system §5.15): every workflow, node, card and variable of
 * the open bot, and the pages around it. Knowledge bases and tables join when they exist (phases 9
 * and 10). Pure, so the list is tested without a screen.
 */

export type Page = "home" | "canvas" | "variables" | "general" | "members" | "api-keys";

export type GoToTarget =
  | { type: "workflow"; workflowId: string }
  | { type: "node"; workflowId: string; nodeId: string; cardId?: string }
  | { type: "page"; page: Page };

export interface GoToItem {
  id: string;
  label: string;
  /** Where it is, shown quietly after the label: the workflow of a node, the node of a card. */
  context?: string;
  /** What it is, on the end side: "Workflow", "Node", "Card", "Variable", "Page", "Settings". */
  kind: string;
  target: GoToTarget;
  /** Text the query is matched against. */
  search: string;
}

const PAGES: { page: Page; label: string; kind: string; keywords: string }[] = [
  { page: "canvas", label: "Workflows", kind: "Page", keywords: "canvas" },
  { page: "variables", label: "Variables", kind: "Page", keywords: "inputs outputs" },
  { page: "home", label: "Home", kind: "Page", keywords: "bots workspace" },
  { page: "general", label: "General", kind: "Settings", keywords: "workspace name" },
  { page: "members", label: "Members", kind: "Settings", keywords: "people invite roles" },
  { page: "api-keys", label: "API keys", kind: "Settings", keywords: "tokens" },
];

export function goToItems(manifest: BotManifest, workflows: readonly Workflow[]): GoToItem[] {
  const ordered = orderWorkflows(workflows);
  const names = new Map(workflows.map((w) => [w.id, { name: w.name }]));
  const items: GoToItem[] = ordered.map((wf) => ({
    id: `wf:${wf.id}`,
    label: wf.name,
    kind: "Workflow",
    target: { type: "workflow", workflowId: wf.id },
    search: wf.name,
  }));
  items.push(
    ...PAGES.map((p) => ({
      id: `page:${p.page}`,
      label: p.label,
      kind: p.kind,
      target: { type: "page", page: p.page } as const,
      search: `${p.label} ${p.kind} ${p.keywords}`,
    })),
  );
  for (const v of manifest.variables) {
    items.push({
      id: `var:${v.id}`,
      label: `${v.scope}.${v.name}`,
      kind: "Variable",
      target: { type: "page", page: "variables" },
      search: `${v.scope}.${v.name}`,
    });
  }
  for (const wf of ordered) {
    const ctx = {
      variables: new Map([...manifest.variables, ...wf.variables].map((v) => [v.id, v])),
      workflows: names,
    };
    for (const v of wf.variables) {
      items.push({
        id: `var:${v.id}`,
        label: `workflow.${v.name}`,
        context: wf.name,
        kind: "Variable",
        target: { type: "page", page: "variables" },
        search: `workflow.${v.name} ${wf.name}`,
      });
    }
    for (const node of wf.nodes) {
      items.push({
        id: `node:${node.id}`,
        label: node.name,
        context: wf.name,
        kind: "Node",
        target: { type: "node", workflowId: wf.id, nodeId: node.id },
        search: `${node.name} ${NODE_TYPE_LABELS[node.type]} ${wf.name}`,
      });
      if (node.type !== "standard") continue;
      for (const card of node.cards) {
        const summary = summarizeCard(card, ctx) || CARD_NAMES[card.type];
        items.push({
          id: `card:${card.id}`,
          label: `${node.name} › ${summary}`,
          context: wf.name,
          kind: "Card",
          target: { type: "node", workflowId: wf.id, nodeId: node.id, cardId: card.id },
          search: `${node.name} ${summary} ${CARD_NAMES[card.type]}`,
        });
      }
    }
  }
  return items;
}
