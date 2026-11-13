import { z } from "zod";
import { cardPortKeys } from "./card";
import { DisplayName, EdgeId, NodeId, WorkflowId } from "./common";
import { Node } from "./node";
import { IoField, Variable } from "./variable";

/**
 * Port ids:
 *   next                      default exit of a node (after its last card)
 *   error                     autonomous node failure
 *   exit:<exitId>             autonomous node exit
 *   card:<cardId>:<key>       card port; keys come from `cardPortKeys`
 */
export const PortId = z
  .string()
  .regex(/^(next|error|exit:exit_[0-9A-Za-z]{10}|card:card_[0-9A-Za-z]{10}:[^\s]{1,520})$/, "Unknown port format");
export type PortId = z.infer<typeof PortId>;

/** A transition. One edge per (node, port). Targets are nodes, never cards. */
export const Edge = z.object({
  id: EdgeId,
  from: z.object({ nodeId: NodeId, port: PortId }),
  to: z.object({ nodeId: NodeId }),
});
export type Edge = z.infer<typeof Edge>;

export const NodeLayout = z.object({
  x: z.number(),
  y: z.number(),
  /** Notes only. */
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

export const Workflow = z.object({
  id: WorkflowId,
  name: DisplayName,
  description: z.string().max(1_000).optional(),
  /** main: where conversations start (one per bot) · sub: callable · error: bot-level error handling (at most one). */
  kind: z.enum(["main", "sub", "error"]),
  /** Declared parameters; only for `sub`. Available as workflow variables of the same name. */
  inputs: z.array(IoField).max(30).default([]),
  /** Declared results; only for `sub`. Set by Exit nodes. */
  outputs: z.array(IoField).max(30).default([]),
  /** Workflow-scoped variables (scope must be `workflow`). */
  variables: z.array(Variable).max(200).default([]),
  nodes: z.array(Node).max(1_000),
  edges: z.array(Edge).max(5_000).default([]),
  /** Canvas positions, keyed by node id. Kept apart from logic so moves do not appear in diffs. */
  layout: z.record(NodeId, NodeLayout).default({}),
});
export type Workflow = z.infer<typeof Workflow>;

/** All output ports a node exposes, in display order. */
export function nodePorts(node: Node): string[] {
  switch (node.type) {
    case "start":
    case "entry":
    case "trigger":
    case "error_handler":
      return ["next"];
    case "standard": {
      const ports: string[] = [];
      for (const card of node.cards) {
        for (const key of cardPortKeys(card)) ports.push(`card:${card.id}:${key}`);
      }
      const last = node.cards.at(-1);
      const endsHere = last?.type === "handoff" || last?.type === "end";
      if (!endsHere) ports.push("next");
      return ports;
    }
    case "autonomous":
      return [...node.exits.map((e) => `exit:${e.id}`), "error"];
    case "exit":
    case "end":
    case "note":
      return [];
  }
}

/**
 * Structural rules checked on every edit (full list in 03-architecture.md §3.1).
 * Returns issues; an empty array means the workflow is structurally valid.
 */
export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  fix: string;
  path: string;
}

export function checkWorkflowStructure(wf: Workflow): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const add = (severity: Issue["severity"], code: string, message: string, fix: string, path: string) =>
    issues.push({ severity, code, message, fix, path });

  const count = (t: Node["type"]) => wf.nodes.filter((n) => n.type === t).length;
  if (wf.kind === "main" && count("start") !== 1)
    add(
      "error",
      "start_node_count",
      "The main workflow needs exactly one Start node.",
      "Keep one Start node.",
      "nodes",
    );
  if (wf.kind !== "main" && count("start") > 0)
    add(
      "error",
      "start_outside_main",
      "Only the main workflow can have a Start node.",
      "Remove it or use an Entry node.",
      "nodes",
    );
  if (wf.kind === "sub" && count("entry") !== 1)
    add("error", "entry_node_count", "A sub-workflow needs exactly one Entry node.", "Keep one Entry node.", "nodes");
  if (wf.kind === "sub" && count("exit") < 1)
    add("error", "exit_node_missing", "A sub-workflow needs at least one Exit node.", "Add an Exit node.", "nodes");
  if (count("error_handler") > 1)
    add("error", "error_handler_count", "A workflow can have one Error handler.", "Remove the extra handler.", "nodes");

  const seenPorts = new Set<string>();
  // biome-ignore lint/suspicious/useIterableCallbackReturn: copied verbatim from docs/04-contracts; the returned value is discarded.
  wf.edges.forEach((e, i) => {
    const from = byId.get(e.from.nodeId);
    const to = byId.get(e.to.nodeId);
    const path = `edges[${i}]`;
    if (!from)
      return add(
        "error",
        "edge_source_missing",
        "A transition starts at a node that no longer exists.",
        "Delete the transition.",
        path,
      );
    if (!to)
      return add(
        "error",
        "edge_target_missing",
        "A transition points to a node that no longer exists.",
        "Reconnect or delete it.",
        path,
      );
    if (!nodePorts(from).includes(e.from.port))
      add(
        "error",
        "edge_port_missing",
        `"${from.name}" no longer has this output.`,
        "Delete the transition or restore the option.",
        path,
      );
    if (["start", "entry", "trigger", "error_handler", "note"].includes(to.type))
      add(
        "error",
        "edge_target_invalid",
        `"${to.name}" cannot be the target of a transition.`,
        "Connect to a different node.",
        path,
      );
    const key = `${e.from.nodeId}|${e.from.port}`;
    if (seenPorts.has(key))
      add("error", "edge_duplicate", `"${from.name}" has two transitions from the same output.`, "Keep one.", path);
    seenPorts.add(key);
  });

  for (const node of wf.nodes) {
    if (node.type !== "autonomous") continue;
    for (const exit of node.exits) {
      if (!seenPorts.has(`${node.id}|exit:${exit.id}`))
        add(
          "error",
          "exit_unconnected",
          `Exit "${exit.name}" on "${node.name}" leads nowhere.`,
          "Connect it to a node or remove the exit.",
          `nodes.${node.id}.exits`,
        );
    }
    const names = new Set<string>();
    for (const tool of node.tools) {
      if (names.has(tool.name))
        add(
          "error",
          "tool_name_duplicate",
          `Two tools on "${node.name}" are named "${tool.name}".`,
          "Rename one.",
          `nodes.${node.id}.tools`,
        );
      names.add(tool.name);
    }
    if (!node.conversational && node.exits.length === 0)
      add(
        "error",
        "autonomous_no_exit",
        `"${node.name}" cannot talk to the user and has no exit.`,
        "Add an exit or allow conversation.",
        `nodes.${node.id}`,
      );
  }

  for (const v of wf.variables) {
    if (v.scope !== "workflow")
      add(
        "error",
        "variable_scope",
        `Variable "${v.name}" is declared in a workflow but is not workflow-scoped.`,
        "Move it to bot settings or change its scope.",
        "variables",
      );
  }
  return issues;
}
