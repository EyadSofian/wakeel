import { type Card, type Node, type NodeType, newElementId } from "@wakeel/contracts";

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
