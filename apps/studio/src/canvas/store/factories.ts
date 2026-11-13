import { type Card, type Node, type NodeType, newElementId, type Variable, type Workflow } from "@wakeel/contracts";

/**
 * New nodes and cards with schema-valid defaults (task 2.3). Defaults are placeholders the builder
 * replaces; cards that must point at something (a variable, a workflow, a knowledge base, a table)
 * take that reference from the caller, because a random id would read as "no longer exists".
 */

export const NODE_NAMES: Record<NodeType, string> = {
  start: "Start",
  entry: "Entry",
  standard: "Standard node",
  autonomous: "Autonomous node",
  exit: "Exit",
  end: "End",
  trigger: "Trigger",
  error_handler: "Error handler",
  note: "Note",
};

export function createNode(type: NodeType, name: string = NODE_NAMES[type]): Node {
  const id = newElementId("node");
  switch (type) {
    case "standard":
      return { id, name, type, cards: [] };
    case "autonomous":
      return {
        id,
        name,
        type,
        instructions: "",
        tools: [],
        variableAccess: [],
        exits: [],
        conversational: true,
        allowHandoff: false,
        maxIterations: 6,
        temperature: 0.3,
        messageTypes: ["text", "choice"],
      };
    case "exit":
      return { id, name, type, outputs: {} };
    case "end":
      return { id, name, type, reason: "completed" };
    case "trigger":
      return { id, name, type, on: { kind: "event", name: "custom_event" } };
    case "note":
      return { id, name, type, text: "" };
    case "start":
    case "entry":
    case "error_handler":
      return { id, name, type };
  }
}

/** Cards that need nothing from the caller. The others are built by their add menu (2.5). */
export type SimpleCardType = "say" | "branch" | "code" | "end" | "log" | "set_timeout" | "handoff";

export function createCard(type: SimpleCardType): Card {
  const id = newElementId("card");
  const base = { id, disabled: false };
  switch (type) {
    case "say":
      return { ...base, type, message: { type: "text", text: "New message", format: "markdown" } };
    case "branch":
      return { ...base, type, branches: [{ id: newElementId("br"), label: "Condition 1", when: "true" }] };
    case "code":
      return { ...base, type, source: "", timeoutMs: 10_000 };
    case "end":
      return { ...base, type, reason: "completed" };
    case "log":
      return { ...base, type, level: "info", message: "Log message" };
    case "set_timeout":
      return { ...base, type, minutes: 1_440 };
    case "handoff":
      return { ...base, type, reason: "", summary: "auto", include: [] };
  }
}

/** Card types offered by the card menu (the MVP set, contracts `MVP_CARD_TYPES`). */
export type MenuCardType =
  | "say"
  | "capture"
  | "branch"
  | "set_variable"
  | "code"
  | "kb_search"
  | "table"
  | "call_workflow"
  | "handoff"
  | "end"
  | "log";

/** What adding a card from the menu does: a card, a card and the variable it writes, or nothing yet. */
export type MenuCard = { card: Card; variable?: Variable } | { unavailable: string };

/** A workflow variable name not yet used in `wf`: `answer`, `answer_2`, … */
function freeName(wf: Workflow, base: string): string {
  const taken = new Set(wf.variables.map((v) => v.name));
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

function workflowVariable(wf: Workflow, base: string): Variable {
  return { id: newElementId("var"), name: freeName(wf, base), scope: "workflow", type: "string", sensitive: false };
}

/**
 * A new card of `type` for the card menu. Cards that write a value get a new workflow variable to
 * write it to; cards that need a knowledge base, a table or a sub-workflow are unavailable until the
 * bot has one, with the reason shown in the menu.
 */
export function createMenuCard(type: MenuCardType, wf: Workflow, workflows: readonly Workflow[]): MenuCard {
  const base = { id: newElementId("card"), disabled: false };
  switch (type) {
    case "capture": {
      const variable = workflowVariable(wf, "answer");
      return {
        card: {
          ...base,
          type,
          prompt: { type: "text", text: "What can I help you with?", format: "markdown" },
          kind: "text",
          into: variable.id,
          maxRetries: 2,
          skipIfFilled: false,
          routeByOption: false,
        },
        variable,
      };
    }
    case "set_variable": {
      const variable = workflowVariable(wf, "value");
      return { card: { ...base, type, assignments: [{ variableId: variable.id, value: '""' }] }, variable };
    }
    case "kb_search":
      return { unavailable: "Create a knowledge base first" };
    case "table":
      return { unavailable: "Create a table first" };
    case "call_workflow": {
      const sub = workflows.find((w) => w.kind === "sub" && w.id !== wf.id);
      return sub
        ? { card: { ...base, type, workflowId: sub.id, inputs: {}, outputs: {} } }
        : { unavailable: "Create a sub-workflow first" };
    }
    default:
      return { card: createCard(type) };
  }
}
