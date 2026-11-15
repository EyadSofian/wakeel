import type { Card, CardType, MessageTemplate, Node, NodeType, Variable, Workflow } from "@wakeel/contracts";
import type { Category } from "@wakeel/ui";
import {
  BookOpenText,
  Braces,
  CircleStop,
  Code,
  GitFork,
  LayoutList,
  LogIn,
  LogOut,
  type LucideIcon,
  MessageCircleQuestionMark,
  MessageSquare,
  Play,
  ScanText,
  ScrollText,
  Sparkles,
  Split,
  StickyNote,
  Table2,
  Timer,
  TriangleAlert,
  UserRound,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";

/**
 * Names, icons and one-line summaries for the canvas (design system §3.1, §5.1). A summary is
 * plain text built from the card's configuration; it may hold builder text (Arabic or mixed), so
 * the row renders it with dir="auto" and truncates with CSS, never by slicing.
 */

/** Card names as the add-card menu shows them (design system §3.1). */
export const CARD_NAMES: Record<CardType, string> = {
  say: "Send message",
  capture: "Ask",
  branch: "Condition",
  ai_branch: "AI condition",
  set_variable: "Set variable",
  code: "Run code",
  kb_search: "Search knowledge",
  table: "Table",
  call_workflow: "Run workflow",
  ai_generate: "Generate text",
  ai_extract: "Extract data",
  handoff: "Hand off to a person",
  end: "End conversation",
  set_timeout: "Set timeout",
  log: "Log",
};

export const CARD_ICONS: Record<CardType, LucideIcon> = {
  say: MessageSquare,
  capture: MessageCircleQuestionMark,
  branch: Split,
  ai_branch: GitFork,
  set_variable: Braces,
  code: Code,
  kb_search: BookOpenText,
  table: Table2,
  call_workflow: WorkflowIcon,
  ai_generate: Sparkles,
  ai_extract: ScanText,
  handoff: UserRound,
  end: CircleStop,
  set_timeout: Timer,
  log: ScrollText,
};

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
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

export const NODE_ICONS: Record<NodeType, LucideIcon> = {
  start: Play,
  entry: LogIn,
  standard: LayoutList,
  autonomous: Sparkles,
  exit: LogOut,
  end: CircleStop,
  trigger: Zap,
  error_handler: TriangleAlert,
  note: StickyNote,
};

/** Names the summaries need: variables by id and workflows by id. */
export interface SummaryContext {
  variables: ReadonlyMap<string, Variable>;
  workflows: ReadonlyMap<string, Pick<Workflow, "name">>;
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim() ?? "";

const variableName = (ctx: SummaryContext, id: string | undefined) => {
  if (id === undefined) return "";
  const v = ctx.variables.get(id);
  return v ? `${v.scope}.${v.name}` : "a missing variable";
};

function messageSummary(m: MessageTemplate): string {
  switch (m.type) {
    case "text":
      return firstLine(m.text);
    case "image":
      return m.caption ? firstLine(m.caption) : "Image";
    case "file":
      return firstLine(m.name);
    case "location":
      return m.title ? firstLine(m.title) : "Location";
    case "choice":
    case "dropdown":
      return firstLine(m.text);
    case "card":
      return firstLine(m.title);
    case "carousel":
      return `Carousel of ${m.items.length}`;
    case "custom":
      return m.name;
  }
}

/** One line for a card row. Uses the card's label when the builder gave one. */
export function summarizeCard(card: Card, ctx: SummaryContext): string {
  if (card.label) return card.label;
  switch (card.type) {
    case "say":
      return messageSummary(card.message);
    case "capture":
      return messageSummary(card.prompt);
    case "branch":
      return card.branches.map((b) => b.label).join(" · ");
    case "ai_branch":
      return card.branches.map((b) => b.label).join(" · ");
    case "set_variable":
      return card.assignments.map((a) => variableName(ctx, a.variableId)).join(", ");
    case "code":
      return firstLine(card.source) || "Empty code";
    case "kb_search":
      return firstLine(card.query);
    case "table":
      return `${card.operation[0]?.toUpperCase() ?? ""}${card.operation.slice(1)} rows`;
    case "call_workflow":
      return ctx.workflows.get(card.workflowId)?.name ?? "A missing workflow";
    case "ai_generate":
      return firstLine(card.instructions);
    case "ai_extract":
      return card.into ? `Into ${variableName(ctx, card.into)}` : "Extract data";
    case "handoff":
      return firstLine(card.reason) || "Hand off to a person";
    case "end":
      return firstLine(card.reason) || "End conversation";
    case "set_timeout":
      return card.minutes === 0 ? "Never expire" : `After ${card.minutes} minutes`;
    case "log":
      return firstLine(card.message);
  }
}

/** One labelled output row of a node, in display order (design system §5.1). */
export interface OutputRow {
  port: string;
  label: string;
}

/** Outputs that are not on a card row: `next`, Autonomous exits and `error`. */
export function nodeOutputRows(node: Node): OutputRow[] {
  switch (node.type) {
    case "autonomous":
      return [...node.exits.map((e) => ({ port: `exit:${e.id}`, label: e.name })), { port: "error", label: "error" }];
    case "standard": {
      const last = node.cards.at(-1);
      return last?.type === "handoff" || last?.type === "end" ? [] : [{ port: "next", label: "next" }];
    }
    case "start":
    case "entry":
    case "trigger":
    case "error_handler":
      return [{ port: "next", label: "next" }];
    default:
      return [];
  }
}

/** Card outputs with readable labels: branch labels, option values, failed, error, not found. */
export function cardOutputRows(card: Card): OutputRow[] {
  const port = (key: string) => `card:${card.id}:${key}`;
  switch (card.type) {
    case "branch":
    case "ai_branch":
      return card.branches.map((b) => ({ port: port(`branch:${b.id}`), label: b.label }));
    case "capture": {
      const rows: OutputRow[] = [];
      if (card.routeByOption && card.prompt.type === "choice") {
        for (const o of card.prompt.options) rows.push({ port: port(`option:${o.value}`), label: o.label });
      }
      rows.push({ port: port("failed"), label: "failed" });
      return rows;
    }
    case "code":
      return [{ port: port("error"), label: "error" }];
    case "kb_search":
      return [{ port: port("not_found"), label: "not found" }];
    case "table":
      return card.operation === "find" || card.operation === "get"
        ? [{ port: port("not_found"), label: "not found" }]
        : [];
    default:
      return [];
  }
}

/** Node and card categories (ADR-017): the colour of the icon tile, the border and the ports. */
export const NODE_CATEGORY: Record<NodeType, Category> = {
  start: "trigger",
  entry: "trigger",
  trigger: "trigger",
  standard: "logic",
  autonomous: "ai",
  exit: "flow",
  end: "flow",
  error_handler: "human",
  note: "tool",
};

export const CARD_CATEGORY: Record<CardType, Category> = {
  say: "logic",
  capture: "logic",
  branch: "logic",
  set_variable: "logic",
  set_timeout: "logic",
  log: "logic",
  end: "flow",
  ai_branch: "ai",
  ai_generate: "ai",
  ai_extract: "ai",
  code: "tool",
  kb_search: "tool",
  table: "tool",
  call_workflow: "tool",
  handoff: "human",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The second line of a node header: what the node is, and the one count that matters. */
export function nodeSubtitle(node: Node): string {
  switch (node.type) {
    case "start":
      return "The conversation starts here";
    case "entry":
      return "The workflow starts here";
    case "standard":
      return node.cards.length === 0
        ? "Standard node"
        : `Standard node · ${plural(node.cards.length, "card", "cards")}`;
    case "autonomous":
      return `Autonomous · ${plural(node.exits.length, "exit", "exits")} · ${plural(node.tools.length, "tool", "tools")}`;
    case "exit":
      return "Returns to the caller";
    case "end":
      return node.reason === "completed" ? "Ends the conversation" : `Ends: ${node.reason.replaceAll("_", " ")}`;
    case "trigger":
      return node.on.kind === "event" ? `On event ${node.on.name}` : `On ${node.on.kind.replaceAll("_", " ")}`;
    case "error_handler":
      return "Runs when a step fails";
    case "note":
      return "Note";
  }
}
