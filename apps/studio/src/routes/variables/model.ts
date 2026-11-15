import {
  type BotManifest,
  type Json,
  parseCodeBody,
  parseExpression,
  parseTemplate,
  type ReferenceUsage,
  type Variable,
  type VariableScope,
  type VariableType,
  visitWorkflowFields,
  type Workflow,
} from "@wakeel/contracts";
import { CARD_NAMES } from "../../canvas/view/summaries";

/**
 * The Variables screen's data (design system §5.7, task 2.7), kept apart from React so it can be
 * tested: groups in screen order, defaults as text and back, and where a usage is.
 */

export interface VariableGroup {
  key: string;
  title: string;
  description: string;
  scope: VariableScope;
  /** Set for a workflow's group. */
  workflow?: Workflow;
  variables: Variable[];
}

const SCOPES: { scope: Exclude<VariableScope, "workflow">; title: string; description: string }[] = [
  { scope: "bot", title: "Bot", description: "Set here; read-only while the bot runs." },
  { scope: "user", title: "User", description: "Kept per person, across conversations." },
  { scope: "conversation", title: "Conversation", description: "Kept for one conversation, across workflows." },
];

const KIND_ORDER: Record<Workflow["kind"], number> = { main: 0, sub: 1, error: 2 };

/** Main first, then sub-workflows by name, then the error workflow. */
export function orderWorkflows(workflows: readonly Workflow[]): Workflow[] {
  return [...workflows].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}

/** Bot, User, Conversation, then each workflow (§5.7). */
export function variableGroups(manifest: BotManifest, workflows: readonly Workflow[]): VariableGroup[] {
  return [
    ...SCOPES.map((s) => ({
      key: s.scope,
      title: s.title,
      description: s.description,
      scope: s.scope,
      variables: manifest.variables.filter((v) => v.scope === s.scope),
    })),
    ...orderWorkflows(workflows).map((wf) => ({
      key: wf.id,
      title: wf.name,
      description:
        wf.kind === "sub"
          ? "Workflow variables, inputs and outputs. Cleared when the workflow returns."
          : "Workflow variables. Cleared when the workflow ends.",
      scope: "workflow" as const,
      workflow: wf,
      variables: wf.variables,
    })),
  ];
}

export const TYPE_LABELS: Record<VariableType, string> = {
  string: "Text",
  number: "Number",
  boolean: "Yes or no",
  date: "Date",
  enum: "One of a list",
  object: "Object",
  array: "List",
  any: "Any",
};

/** The default as one line of text for the table; empty when there is none. */
export function formatDefault(v: Pick<Variable, "default">): string {
  if (v.default === undefined) return "";
  if (typeof v.default === "string") return v.default;
  return JSON.stringify(v.default);
}

/** The text the builder edits for a default. */
export function defaultText(v: Pick<Variable, "default" | "type">): string {
  if (v.default === undefined) return "";
  if (typeof v.default === "string") return v.default;
  return JSON.stringify(v.default, null, v.type === "object" || v.type === "array" ? 2 : undefined);
}

export type ParsedDefault = { ok: true; value: Json | undefined } | { ok: false; reason: string };

/** Reads the default the builder typed, for the chosen type. Empty means no default. */
export function parseDefault(type: VariableType, text: string, enumValues: readonly string[] = []): ParsedDefault {
  if (text.trim() === "") return { ok: true, value: undefined };
  switch (type) {
    case "string":
      return { ok: true, value: text };
    case "date":
      return Number.isNaN(Date.parse(text.trim()))
        ? { ok: false, reason: "Enter a date like 2026-11-13." }
        : { ok: true, value: text.trim() };
    case "number": {
      const n = Number(text.trim());
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: "Enter a number, like 12 or 2.5." };
    }
    case "boolean":
      if (text === "true" || text === "false") return { ok: true, value: text === "true" };
      return { ok: false, reason: "Choose yes or no." };
    case "enum":
      return enumValues.includes(text)
        ? { ok: true, value: text }
        : { ok: false, reason: "Choose one of the allowed values." };
    case "object":
    case "array":
    case "any": {
      let value: Json;
      try {
        value = JSON.parse(text) as Json;
      } catch {
        return { ok: false, reason: 'Enter valid JSON, like {"plan": "pro"}.' };
      }
      if (type === "array" && !Array.isArray(value)) return { ok: false, reason: "Enter a JSON list, like [1, 2]." };
      if (type === "object" && (value === null || typeof value !== "object" || Array.isArray(value)))
        return { ok: false, reason: 'Enter a JSON object, like {"plan": "pro"}.' };
      return { ok: true, value };
    }
  }
}

/** Allowed values typed one per line; blanks and repeats dropped. */
export function parseEnumValues(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    ),
  ];
}

const FIELD_LABELS: Record<string, string> = {
  message: "Message",
  prompt: "Question",
  into: "Saves to",
  retryMessage: "Retry message",
  validate: "Answer check",
  when: "Condition",
  branches: "Rule",
  input: "Input",
  assignments: "Assignment",
  source: "Code",
  query: "Query",
  answer: "Answer",
  search: "Search",
  values: "Values",
  where: "Filter",
  inputs: "Input",
  outputs: "Output",
  instructions: "Instructions",
  reason: "Reason",
  include: "Included variables",
  data: "Data",
  busyMessage: "Busy message",
  variableAccess: "Variable access",
  tools: "Tool",
  extract: "Extraction",
};

/** "Ask · Saves to" for a card field; "Instructions" for a node field. */
export function usageField(usage: ReferenceUsage, wf: Workflow | undefined): string {
  const first = usage.field.split(/[.[]/)[0] ?? "";
  const field = FIELD_LABELS[first] ?? first;
  if (!usage.cardId || !wf) return field;
  const node = wf.nodes.find((n) => n.id === usage.nodeId);
  const card = node?.type === "standard" ? node.cards.find((c) => c.id === usage.cardId) : undefined;
  if (!card) return field;
  return `${card.label ?? CARD_NAMES[card.type]} · ${field}`;
}

/** Usages collapsed to one row per node and card, with how many times each refers to it. */
export function groupUsages(usages: readonly ReferenceUsage[]): (ReferenceUsage & { count: number })[] {
  const out = new Map<string, ReferenceUsage & { count: number }>();
  for (const u of usages) {
    const key = `${u.workflowId}|${u.nodeId}|${u.cardId ?? ""}|${u.field.split(/[.[]/)[0]}`;
    const prev = out.get(key);
    if (prev) prev.count++;
    else out.set(key, { ...u, count: 1 });
  }
  return [...out.values()];
}

/** "Used in" counts references: a condition that names a variable twice uses it twice. */
export const usesLabel = (n: number) => (n === 0 ? "Not used" : n === 1 ? "1 use" : `${n} uses`);
export const placesLabel = (n: number) => (n === 1 ? "1 place" : `${n} places`);

/**
 * How many places use each variable, input and output, from one pass over the bot: every text is
 * parsed once, not once per variable. Agrees with `findUsages` (tested).
 */
export function usageCounts(def: { manifest: BotManifest; workflows: readonly Workflow[] }) {
  const names = new Map<string, number>();
  const ids = new Map<string, number>();
  const mappings = new Map<string, number>();
  const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
  for (const wf of def.workflows) {
    visitWorkflowFields(wf, {
      text: (value, kind) => {
        const parsed =
          kind === "template"
            ? parseTemplate(value)
            : kind === "expression"
              ? parseExpression(value)
              : parseCodeBody(value);
        if (parsed.ok) for (const r of parsed.refs) bump(names, `${wf.id}|${r.root}.${r.name}`);
        return value;
      },
      variableId: (id) => {
        bump(ids, id);
        return id;
      },
    });
    for (const node of wf.nodes) {
      if (node.type === "exit")
        for (const name of Object.keys(node.outputs)) bump(mappings, `${wf.id}|outputs|${name}`);
      if (node.type !== "standard") continue;
      for (const c of node.cards) {
        if (c.type !== "call_workflow") continue;
        for (const name of Object.keys(c.inputs)) bump(mappings, `${c.workflowId}|inputs|${name}`);
        for (const name of Object.keys(c.outputs)) bump(mappings, `${c.workflowId}|outputs|${name}`);
      }
    }
  }
  const named = (wfId: string, ref: string) => names.get(`${wfId}|${ref}`) ?? 0;
  return {
    variable(v: Variable, workflowId?: string): number {
      const byName =
        workflowId === undefined
          ? def.workflows.reduce((n, wf) => n + named(wf.id, `${v.scope}.${v.name}`), 0)
          : named(workflowId, `workflow.${v.name}`);
      return byName + (ids.get(v.id) ?? 0);
    },
    io(workflowId: string, kind: "input" | "output", name: string): number {
      const mapped = mappings.get(`${workflowId}|${kind === "input" ? "inputs" : "outputs"}|${name}`) ?? 0;
      return mapped + (kind === "input" ? named(workflowId, `workflow.${name}`) : 0);
    },
  };
}
