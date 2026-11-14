import type { BotDefinition, Node, Variable, Workflow } from "@wakeel/contracts";

export type TriggerNode = Extract<Node, { type: "trigger" }>;
export type TriggerOn = TriggerNode["on"];

/** A variable and the workflow that declares it (absent for bot, user and conversation variables). */
export interface VariableEntry {
  variable: Variable;
  workflowId?: string;
}

/**
 * Lookups over a bot definition, built once per definition object. The engine reads definitions
 * through this index only; it never changes them.
 */
export class DefinitionIndex {
  readonly definition: BotDefinition;
  readonly #workflows = new Map<string, Workflow>();
  readonly #nodes = new Map<string, Node>();
  readonly #edges = new Map<string, string>();
  readonly #variables = new Map<string, VariableEntry>();

  constructor(definition: BotDefinition) {
    this.definition = definition;
    for (const v of definition.manifest.variables) this.#variables.set(v.id, { variable: v });
    for (const wf of definition.workflows) {
      this.#workflows.set(wf.id, wf);
      for (const node of wf.nodes) this.#nodes.set(`${wf.id}|${node.id}`, node);
      for (const edge of wf.edges) this.#edges.set(`${wf.id}|${edge.from.nodeId}|${edge.from.port}`, edge.to.nodeId);
      for (const v of wf.variables) this.#variables.set(v.id, { variable: v, workflowId: wf.id });
    }
  }

  get mainWorkflowId(): string {
    return this.definition.manifest.mainWorkflowId;
  }

  workflow(id: string): Workflow | undefined {
    return this.#workflows.get(id);
  }

  node(workflowId: string, nodeId: string): Node | undefined {
    return this.#nodes.get(`${workflowId}|${nodeId}`);
  }

  /** The node an edge from `(nodeId, port)` leads to, if that port is connected. */
  target(workflowId: string, nodeId: string, port: string): string | undefined {
    return this.#edges.get(`${workflowId}|${nodeId}|${port}`);
  }

  variable(id: string): VariableEntry | undefined {
    return this.#variables.get(id);
  }

  /** The first node of a type in a workflow (Start, Entry and Error handler occur at most once). */
  first<T extends Node["type"]>(workflowId: string, type: T): Extract<Node, { type: T }> | undefined {
    return this.workflow(workflowId)?.nodes.find((n): n is Extract<Node, { type: T }> => n.type === type);
  }

  triggers(workflowId: string): TriggerNode[] {
    return this.workflow(workflowId)?.nodes.filter((n): n is TriggerNode => n.type === "trigger") ?? [];
  }
}

const cache = new WeakMap<BotDefinition, DefinitionIndex>();

/** The index for a definition, built on first use. The engine never mutates a definition, and callers pass a new object for a new draft, so the cache cannot go stale. */
export function indexDefinition(definition: BotDefinition): DefinitionIndex {
  let index = cache.get(definition);
  if (!index) {
    index = new DefinitionIndex(definition);
    cache.set(definition, index);
  }
  return index;
}
