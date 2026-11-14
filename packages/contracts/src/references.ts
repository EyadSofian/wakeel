import { parseExpressionAt } from "acorn";
import type { BotDefinition, BotManifest } from "./bot-definition";
import type { Card, MessageTemplate } from "./card";
import type { Node } from "./node";
import type { Filter } from "./table";
import { type CHECKED_ROOTS, parseCodeBody, parseExpression, parseTemplate } from "./validate/expressions";
import type { IoField, Variable } from "./variable";
import type { Workflow } from "./workflow";

/**
 * Where a bot definition refers to variables and workflow inputs and outputs (task 2.7): the
 * Variables screen's "Used in", delete-while-used, and renames that rewrite every reference.
 *
 * Templates, expressions and code refer to variables by name (`workflow.email`); cards that store a
 * value refer to it by id. Renaming therefore rewrites names inside `{{ }}`, expressions and code,
 * and never touches plain text: "workflow.email" typed outside a placeholder is a sentence, not a
 * reference. Nothing here evaluates builder text (CLAUDE.md §9); it only parses.
 */

export type TextKind = "template" | "expression" | "code";

/** A field in a workflow, located the way validation issues are (`path` matches `DefinitionIssue.path`). */
export interface FieldLocation {
  workflowId: string;
  nodeId: string;
  cardId?: string;
  /** Field inside the node or card: `message.text`, `assignments[0].value`, `outputs.total`. */
  field: string;
}

export interface WorkflowVisitor {
  /** Returns the field's new text; return `value` to leave it as it is. */
  text?(value: string, kind: TextKind, at: FieldLocation): string;
  /** Returns the new id; return `id` to leave it. */
  variableId?(id: string, at: FieldLocation): string;
}

type Root = (typeof CHECKED_ROOTS)[number];

/* ------------------------------------------------------------------ */
/* Renaming inside one piece of text                                   */
/* ------------------------------------------------------------------ */

interface Span {
  start: number;
  end: number;
}

/** Ranges of the property name in every `root.name` (also `root?.name`) member access. */
function propertySpans(ast: unknown, root: Root, name: string, out: Span[]): void {
  if (ast === null || typeof ast !== "object") return;
  const n = ast as {
    type?: string;
    computed?: boolean;
    object?: { type?: string; name?: string };
    property?: { type?: string; name?: string; start: number; end: number };
  };
  if (
    n.type === "MemberExpression" &&
    !n.computed &&
    n.object?.type === "Identifier" &&
    n.object.name === root &&
    n.property?.type === "Identifier" &&
    n.property.name === name
  ) {
    out.push({ start: n.property.start, end: n.property.end });
  }
  for (const [key, value] of Object.entries(ast)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) for (const v of value) propertySpans(v, root, name, out);
    else if (value && typeof value === "object") propertySpans(value, root, name, out);
  }
}

function replaceSpans(text: string, spans: Span[], to: string, offset = 0): string {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start - offset) + to + out.slice(s.end - offset);
  }
  return out;
}

const ECMA = 2023;

function renameInExpression(source: string, root: Root, from: string, to: string): string {
  try {
    const ast = parseExpressionAt(source, 0, { ecmaVersion: ECMA });
    const spans: Span[] = [];
    propertySpans(ast, root, from, spans);
    return spans.length === 0 ? source : replaceSpans(source, spans, to);
  } catch {
    // Text that does not parse has no references we can place; validation reports it.
    return source;
  }
}

function renameInTemplate(text: string, root: Root, from: string, to: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("{{", i);
    if (open === -1) return out + text.slice(i);
    const close = text.indexOf("}}", open + 2);
    if (close === -1) return out + text.slice(i);
    out += `${text.slice(i, open + 2)}${renameInExpression(text.slice(open + 2, close), root, from, to)}}}`;
    i = close + 2;
  }
}

const CODE_PREFIX = "(async function (input, ctx) {\n";

function renameInCode(source: string, root: Root, from: string, to: string): string {
  try {
    const wrapped = `${CODE_PREFIX}${source}\n})`;
    const ast = parseExpressionAt(wrapped, 0, { ecmaVersion: ECMA });
    const spans: Span[] = [];
    propertySpans(ast, root, from, spans);
    return spans.length === 0 ? source : replaceSpans(source, spans, to, CODE_PREFIX.length);
  } catch {
    return source;
  }
}

/** Rewrites every `root.from` reference in `text` to `root.to`, leaving everything else as written. */
export function renameReference(text: string, kind: TextKind, root: Root, from: string, to: string): string {
  if (from === to || !text.includes(from)) return text;
  if (kind === "template") return renameInTemplate(text, root, from, to);
  if (kind === "expression") return renameInExpression(text, root, from, to);
  return renameInCode(text, root, from, to);
}

/** How many times `text` refers to `root.name`. */
export function countReferences(text: string, kind: TextKind, root: Root, name: string): number {
  if (!text.includes(name)) return 0;
  const parsed =
    kind === "template" ? parseTemplate(text) : kind === "expression" ? parseExpression(text) : parseCodeBody(text);
  return parsed.ok ? parsed.refs.filter((r) => r.root === root && r.name === name).length : 0;
}

/* ------------------------------------------------------------------ */
/* Walking every field of a workflow                                   */
/* ------------------------------------------------------------------ */

/**
 * Maps every template, expression, code body and stored-variable id in a workflow. Returns the same
 * object when nothing changed, so callers can tell a no-op from an edit. The field list mirrors
 * `validateDefinition`; a test checks the two agree.
 */
export function mapWorkflowFields(wf: Workflow, visitor: WorkflowVisitor): Workflow {
  let changed = false;
  const nodes = wf.nodes.map((node) => {
    const before = JSON.stringify(node);
    const after = mapNode(wf.id, node, visitor);
    if (after === node) return node;
    if (JSON.stringify(after) === before) return node;
    changed = true;
    return after;
  });
  return changed ? { ...wf, nodes } : wf;
}

type Field = <T extends string | undefined>(value: T, kind: TextKind, field: string, cardId?: string) => T;
type Id = <T extends string | undefined>(id: T, field: string, cardId?: string) => T;

function mapNode(workflowId: string, node: Node, v: WorkflowVisitor): Node {
  const at = (field: string, cardId?: string): FieldLocation => ({
    workflowId,
    nodeId: node.id,
    ...(cardId ? { cardId } : {}),
    field,
  });
  const f: Field = (value, kind, field, cardId) =>
    (value === undefined || !v.text ? value : v.text(value, kind, at(field, cardId))) as typeof value;
  const id: Id = (value, field, cardId) =>
    (value === undefined || !v.variableId ? value : v.variableId(value, at(field, cardId))) as typeof value;

  switch (node.type) {
    case "standard":
      return { ...node, cards: node.cards.map((c) => mapCard(c, f, id)) };
    case "autonomous":
      return {
        ...node,
        instructions: f(node.instructions, "template", "instructions"),
        ...opt("busyMessage", f(node.busyMessage, "template", "busyMessage")),
        variableAccess: node.variableAccess.map((a, i) => ({
          ...a,
          variableId: id(a.variableId, `variableAccess[${i}]`),
        })),
        tools: node.tools.map((t, i) =>
          t.type === "code" ? { ...t, source: f(t.source, "code", `tools[${i}].source`) } : t,
        ),
      };
    case "exit":
      return {
        ...node,
        outputs: mapRecord(node.outputs, (name, e) => f(e, "expression", `outputs.${name}`)),
      };
    case "end":
      return { ...node, reason: f(node.reason, "template", "reason") };
    default:
      return node;
  }
}

/** Spreads `{ key: value }` only when value is defined (exactOptionalPropertyTypes). */
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

const mapRecord = <V>(r: Record<string, V>, fn: (key: string, value: V) => V): Record<string, V> =>
  Object.fromEntries(Object.entries(r).map(([k, x]) => [k, fn(k, x)]));

function mapMessage(m: MessageTemplate, f: Field, field: string, cardId: string): MessageTemplate {
  const t = (value: string | undefined, name: string) => f(value, "template", `${field}.${name}`, cardId);
  switch (m.type) {
    case "text":
      return { ...m, text: f(m.text, "template", `${field}.text`, cardId) };
    case "image":
      return {
        ...m,
        url: f(m.url, "template", `${field}.url`, cardId),
        ...opt("alt", t(m.alt, "alt")),
        ...opt("caption", t(m.caption, "caption")),
      };
    case "file":
      return {
        ...m,
        url: f(m.url, "template", `${field}.url`, cardId),
        name: f(m.name, "template", `${field}.name`, cardId),
      };
    case "location":
      return {
        ...m,
        latitude: f(m.latitude, "expression", `${field}.latitude`, cardId),
        longitude: f(m.longitude, "expression", `${field}.longitude`, cardId),
        ...opt("title", t(m.title, "title")),
        ...opt("address", t(m.address, "address")),
      };
    case "choice":
    case "dropdown": {
      const options = m.options.map((o, i) => ({
        ...o,
        label: f(o.label, "template", `${field}.options[${i}].label`, cardId),
        value: f(o.value, "template", `${field}.options[${i}].value`, cardId),
      }));
      const text = f(m.text, "template", `${field}.text`, cardId);
      return m.type === "choice"
        ? { ...m, text, options }
        : { ...m, text, options, ...opt("placeholder", t(m.placeholder, "placeholder")) };
    }
    case "card":
    case "carousel": {
      type Body = Extract<MessageTemplate, { type: "card" }>;
      const body = <B extends Pick<Body, "title" | "subtitle" | "imageUrl" | "actions">>(b: B, bf: string): B => ({
        ...b,
        title: f(b.title, "template", `${bf}.title`, cardId),
        ...opt("subtitle", f(b.subtitle, "template", `${bf}.subtitle`, cardId)),
        ...opt("imageUrl", f(b.imageUrl, "template", `${bf}.imageUrl`, cardId)),
        actions: b.actions.map((a, j) => ({
          ...a,
          label: f(a.label, "template", `${bf}.actions[${j}].label`, cardId),
          value: f(a.value, "template", `${bf}.actions[${j}].value`, cardId),
        })),
      });
      return m.type === "card"
        ? body(m, field)
        : { ...m, items: m.items.map((b, i) => body(b, `${field}.items[${i}]`)) };
    }
    case "custom":
      return { ...m, data: f(m.data, "expression", `${field}.data`, cardId) };
  }
}

function mapFilter(filter: Filter<string>, f: Field, field: string, cardId: string): Filter<string> {
  if ("and" in filter && Array.isArray(filter.and))
    return { and: filter.and.map((x) => mapFilter(x, f, field, cardId)) };
  if ("or" in filter && Array.isArray(filter.or)) return { or: filter.or.map((x) => mapFilter(x, f, field, cardId)) };
  if ("not" in filter && filter.not && typeof filter.not === "object" && !Array.isArray(filter.not))
    return { not: mapFilter(filter.not as Filter<string>, f, field, cardId) };
  const columns = filter as Record<string, Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(columns).map(([col, ops]) => [
      col,
      Object.fromEntries(
        Object.entries(ops).map(([op, value]) => [
          op,
          typeof value === "string"
            ? f(value, "expression", `${field}.${col}.${op}`, cardId)
            : Array.isArray(value)
              ? value.map((x, i) =>
                  typeof x === "string" ? f(x, "expression", `${field}.${col}.${op}[${i}]`, cardId) : x,
                )
              : value,
        ]),
      ),
    ]),
  ) as Filter<string>;
}

function mapCard(card: Card, f: Field, id: Id): Card {
  const c = card.id;
  switch (card.type) {
    case "say":
      return { ...card, message: mapMessage(card.message, f, "message", c) };
    case "capture":
      return {
        ...card,
        prompt: mapMessage(card.prompt, f, "prompt", c),
        into: id(card.into, "into", c),
        ...opt("retryMessage", f(card.retryMessage, "template", "retryMessage", c)),
        ...(card.extract
          ? {
              extract: {
                ...card.extract,
                ...opt("instructions", f(card.extract.instructions, "template", "extract.instructions", c)),
              },
            }
          : {}),
        ...(card.validate
          ? {
              validate: {
                expression: f(card.validate.expression, "expression", "validate.expression", c),
                message: f(card.validate.message, "template", "validate.message", c),
              },
            }
          : {}),
      };
    case "branch":
      return {
        ...card,
        branches: card.branches.map((b) => ({ ...b, when: f(b.when, "expression", `branches.${b.id}.when`, c) })),
      };
    case "ai_branch":
      return { ...card, input: f(card.input, "template", "input", c) };
    case "set_variable":
      return {
        ...card,
        assignments: card.assignments.map((a, i) => ({
          variableId: id(a.variableId, `assignments[${i}].variableId`, c),
          value: f(a.value, "expression", `assignments[${i}].value`, c),
        })),
      };
    case "code":
      return { ...card, source: f(card.source, "code", "source", c) };
    case "kb_search":
      return {
        ...card,
        query: f(card.query, "template", "query", c),
        ...opt("into", id(card.into, "into", c)),
        ...(card.answer
          ? {
              answer: {
                ...card.answer,
                ...opt("instructions", f(card.answer.instructions, "template", "answer.instructions", c)),
                into: id(card.answer.into, "answer.into", c),
              },
            }
          : {}),
      };
    case "table":
      return {
        ...card,
        ...opt("search", f(card.search, "template", "search", c)),
        ...(card.values ? { values: mapRecord(card.values, (col, e) => f(e, "expression", `values.${col}`, c)) } : {}),
        ...(card.where ? { where: mapFilter(card.where, f, "where", c) } : {}),
        ...opt("into", id(card.into, "into", c)),
      };
    case "call_workflow":
      return {
        ...card,
        inputs: mapRecord(card.inputs, (name, e) => f(e, "expression", `inputs.${name}`, c)),
        outputs: mapRecord(card.outputs, (name, v) => id(v, `outputs.${name}`, c)),
      };
    case "ai_generate":
      return {
        ...card,
        instructions: f(card.instructions, "template", "instructions", c),
        ...opt("input", f(card.input, "template", "input", c)),
        into: id(card.into, "into", c),
      };
    case "ai_extract":
      return {
        ...card,
        input: f(card.input, "template", "input", c),
        ...opt("instructions", f(card.instructions, "template", "instructions", c)),
        into: id(card.into, "into", c),
      };
    case "handoff":
      return {
        ...card,
        reason: f(card.reason, "template", "reason", c),
        include: card.include.map((v, i) => id(v, `include[${i}]`, c)),
        ...(card.message ? { message: mapMessage(card.message, f, "message", c) } : {}),
      };
    case "end":
      return { ...card, reason: f(card.reason, "template", "reason", c) };
    case "log":
      return {
        ...card,
        message: f(card.message, "template", "message", c),
        ...opt("data", f(card.data, "expression", "data", c)),
      };
    case "set_timeout":
      return card;
  }
}

/** Calls `visit` for every field without changing anything. */
export function visitWorkflowFields(wf: Workflow, visitor: WorkflowVisitor): void {
  mapWorkflowFields(wf, {
    text: (value, kind, at) => {
      visitor.text?.(value, kind, at);
      return value;
    },
    variableId: (value, at) => {
      visitor.variableId?.(value, at);
      return value;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Usages                                                              */
/* ------------------------------------------------------------------ */

/** What the Variables screen and the Workflows panel ask about. */
export type ReferenceTarget =
  | { kind: "variable"; variableId: string }
  | { kind: "input"; workflowId: string; name: string }
  | { kind: "output"; workflowId: string; name: string }
  /** Run workflow cards and workflow tools on autonomous nodes that call it (task 2.8). */
  | { kind: "workflow"; workflowId: string };

export interface ReferenceUsage extends FieldLocation {
  /** How it is used: read by name in text, stored into or called by id, or a call/exit mapping key. */
  via: "name" | "id" | "mapping";
}

/** The variable with this id and the workflow that declares it (undefined for bot, user and conversation). */
export function findVariable(
  def: Pick<BotDefinition, "manifest" | "workflows">,
  variableId: string,
): { variable: Variable; workflowId?: string } | undefined {
  const top = def.manifest.variables.find((v) => v.id === variableId);
  if (top) return { variable: top };
  for (const wf of def.workflows) {
    const v = wf.variables.find((x) => x.id === variableId);
    if (v) return { variable: v, workflowId: wf.id };
  }
  return undefined;
}

/** Workflows that can see a variable by name: every workflow for bot-level scopes, else its own. */
const visibleIn = (def: Pick<BotDefinition, "workflows">, owner: string | undefined) =>
  owner === undefined ? def.workflows : def.workflows.filter((w) => w.id === owner);

/** Every place that refers to `target`, in workflow, node and card order. */
export function findUsages(
  def: Pick<BotDefinition, "manifest" | "workflows">,
  target: ReferenceTarget,
): ReferenceUsage[] {
  const out: ReferenceUsage[] = [];
  const byName = (workflows: readonly Workflow[], root: Root, name: string) => {
    for (const wf of workflows) {
      visitWorkflowFields(wf, {
        text: (value, kind, at) => {
          const n = countReferences(value, kind, root, name);
          for (let i = 0; i < n; i++) out.push({ ...at, via: "name" });
          return value;
        },
      });
    }
  };

  if (target.kind === "workflow") {
    for (const wf of def.workflows) {
      for (const node of wf.nodes) {
        if (node.type === "standard") {
          for (const card of node.cards) {
            if (card.type === "call_workflow" && card.workflowId === target.workflowId)
              out.push({ workflowId: wf.id, nodeId: node.id, cardId: card.id, field: "workflowId", via: "id" });
          }
        }
        if (node.type === "autonomous") {
          node.tools.forEach((tool, i) => {
            if (tool.type === "workflow" && tool.workflowId === target.workflowId)
              out.push({ workflowId: wf.id, nodeId: node.id, field: `tools[${i}].workflowId`, via: "id" });
          });
        }
      }
    }
    return out;
  }

  if (target.kind === "variable") {
    const found = findVariable(def, target.variableId);
    if (!found) return out;
    const { variable, workflowId } = found;
    const workflows = visibleIn(def, workflowId);
    for (const wf of workflows) {
      visitWorkflowFields(wf, {
        text: (value, kind, at) => {
          const n = countReferences(value, kind, variable.scope, variable.name);
          for (let i = 0; i < n; i++) out.push({ ...at, via: "name" });
          return value;
        },
        variableId: (id, at) => {
          if (id === variable.id) out.push({ ...at, via: "id" });
          return id;
        },
      });
    }
    return out;
  }

  const owner = def.workflows.find((w) => w.id === target.workflowId);
  if (!owner) return out;
  if (target.kind === "input") byName([owner], "workflow", target.name);
  if (target.kind === "output") {
    for (const node of owner.nodes) {
      if (node.type === "exit" && target.name in node.outputs)
        out.push({ workflowId: owner.id, nodeId: node.id, field: `outputs.${target.name}`, via: "mapping" });
    }
  }
  // Callers name inputs and outputs in their call cards.
  const key = target.kind === "input" ? "inputs" : "outputs";
  for (const wf of def.workflows) {
    for (const node of wf.nodes) {
      if (node.type !== "standard") continue;
      for (const card of node.cards) {
        if (card.type === "call_workflow" && card.workflowId === owner.id && target.name in card[key]) {
          out.push({
            workflowId: wf.id,
            nodeId: node.id,
            cardId: card.id,
            field: `${key}.${target.name}`,
            via: "mapping",
          });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Renames as refactors                                                */
/* ------------------------------------------------------------------ */

/**
 * A rename expressed per document, so the Studio can apply it to the open documents and to every
 * document in undo history alike: undo never brings back a name that no longer exists.
 */
export interface Refactor {
  label: string;
  manifest(m: BotManifest): BotManifest;
  workflow(wf: Workflow): Workflow;
}

const keepManifest = (m: BotManifest) => m;

const renameKey = <V>(r: Record<string, V>, from: string, to: string): Record<string, V> =>
  from in r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k === from ? to : k, v])) : r;

/** Why a new name cannot be used, or undefined when it can. */
export function nameProblem(
  def: Pick<BotDefinition, "manifest" | "workflows">,
  name: string,
  where: { scope: Variable["scope"]; workflowId?: string; exceptVariableId?: string; exceptIo?: string },
): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name))
    return "Use letters, digits and underscores, and start with a letter.";
  if (where.scope !== "workflow") {
    const clash = def.manifest.variables.some(
      (v) => v.scope === where.scope && v.name === name && v.id !== where.exceptVariableId,
    );
    return clash ? `There is already a ${where.scope} variable named "${name}".` : undefined;
  }
  const wf = def.workflows.find((w) => w.id === where.workflowId);
  if (!wf) return "That workflow no longer exists.";
  if (wf.variables.some((v) => v.name === name && v.id !== where.exceptVariableId))
    return `This workflow already has a variable named "${name}".`;
  if (wf.inputs.some((i) => i.name === name && i.name !== where.exceptIo))
    return `This workflow already has an input named "${name}".`;
  return undefined;
}

/**
 * Renames a variable and every reference to it by name. Ids do not change, so cards that store
 * into it need nothing. Undefined when the variable does not exist.
 */
export function renameVariable(
  def: Pick<BotDefinition, "manifest" | "workflows">,
  variableId: string,
  to: string,
): Refactor | undefined {
  const found = findVariable(def, variableId);
  if (!found) return undefined;
  const { variable, workflowId } = found;
  const from = variable.name;
  const rewrite = (wf: Workflow) =>
    mapWorkflowFields(wf, { text: (value, kind) => renameReference(value, kind, variable.scope, from, to) });
  const renameIn = (vars: Variable[]) => vars.map((v) => (v.id === variableId ? { ...v, name: to } : v));
  return {
    label: `Rename ${variable.scope}.${from}`,
    manifest: workflowId === undefined ? (m) => ({ ...m, variables: renameIn(m.variables) }) : keepManifest,
    workflow: (wf) => {
      if (workflowId !== undefined && wf.id !== workflowId) return wf;
      const next = rewrite(wf);
      return workflowId === undefined ? next : { ...next, variables: renameIn(next.variables) };
    },
  };
}

/**
 * Renames a workflow input or output, the references to an input inside its workflow, the Exit
 * node mappings of an output, and the call cards in other workflows that pass or receive it.
 */
export function renameIo(workflowId: string, kind: "input" | "output", from: string, to: string): Refactor {
  const key = kind === "input" ? "inputs" : "outputs";
  const renameField = (fields: IoField[]) => fields.map((f) => (f.name === from ? { ...f, name: to } : f));
  return {
    label: `Rename ${kind} ${from}`,
    manifest: keepManifest,
    workflow: (wf) => {
      let next = wf;
      if (wf.id === workflowId) {
        next = { ...next, [key]: renameField(next[key]) };
        if (kind === "input") {
          next = mapWorkflowFields(next, { text: (value, k) => renameReference(value, k, "workflow", from, to) });
        } else {
          next = {
            ...next,
            nodes: next.nodes.map((n) => (n.type === "exit" ? { ...n, outputs: renameKey(n.outputs, from, to) } : n)),
          };
        }
      }
      let callers = false;
      const nodes = next.nodes.map((n) => {
        if (n.type !== "standard") return n;
        let touched = false;
        const cards = n.cards.map((c) => {
          if (c.type !== "call_workflow" || c.workflowId !== workflowId || !(from in c[key])) return c;
          touched = true;
          return { ...c, [key]: renameKey(c[key], from, to) };
        });
        if (!touched) return n;
        callers = true;
        return { ...n, cards };
      });
      return callers ? { ...next, nodes } : next;
    },
  };
}

/** Applies a refactor to a whole definition (the api and tests; the Studio applies it per document). */
export function applyRefactor<D extends Pick<BotDefinition, "manifest" | "workflows">>(def: D, r: Refactor): D {
  return { ...def, manifest: r.manifest(def.manifest), workflows: def.workflows.map((w) => r.workflow(w)) };
}
