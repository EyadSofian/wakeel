import type { BotDefinition } from "../bot-definition";
import type { Card, MessageTemplate } from "../card";
import { cardPortKeys, TERMINAL_CARD_TYPES } from "../card";
import type { Node } from "../node";
import type { Variable, VariableType } from "../variable";
import { checkWorkflowStructure, type Workflow } from "../workflow";
import { parseCodeBody, parseExpression, parseTemplate, type Reference } from "./expressions";
import { type DefinitionIssue, type IssueCode, type IssueLocation, makeIssue } from "./rules";

export * from "./expressions";
export * from "./rules";

/**
 * Resources that live outside the definition (architecture §3: KBs and tables are live
 * resources). When given, references to them are checked; when absent, they are not.
 */
export interface ValidationContext {
  knowledgeBaseIds?: ReadonlySet<string>;
  tableIds?: ReadonlySet<string>;
}

/** What a capture of each kind stores (architecture §4.5). */
const CAPTURE_TYPES: Record<string, VariableType> = {
  text: "string",
  number: "number",
  boolean: "boolean",
  email: "string",
  phone: "string",
  date: "date",
  choice: "string",
  extract: "object",
};

/** Whether a variable of `actual` type can hold a value of `expected` type. */
function compatible(actual: VariableType, expected: VariableType): boolean {
  if (actual === "any" || expected === "any" || actual === expected) return true;
  // A choice capture's value fits an enum variable; runtime checks the allowed values.
  if (actual === "enum" && expected === "string") return true;
  return false;
}

/**
 * Validates a whole bot definition (task 2.2, architecture §3.1): the structural rules from
 * `checkWorkflowStructure` plus references, types, messages and syntax. Pure and synchronous, with
 * no Node APIs, so the api runs it at publish and the Studio runs it in a web worker on every
 * change. Returns every issue; an empty array means the bot can be published.
 */
export function validateDefinition(def: BotDefinition, ctx: ValidationContext = {}): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const add = (code: IssueCode, params: Record<string, string | number>, at: IssueLocation) =>
    issues.push(makeIssue(code, params, at));

  checkDefinitionShape(def, add);
  checkUniqueIds(def, add);

  const manifestVars = def.manifest.variables;
  checkVariableNames(manifestVars, "manifest.variables", add);
  for (const v of manifestVars) {
    if (v.scope === "workflow") add("variable_scope", { name: v.name }, { path: "manifest.variables" });
  }

  const workflows = new Map(def.workflows.map((w) => [w.id, w]));
  const configKeys = new Set(def.manifest.configVars.map((c) => c.key));

  for (const wf of def.workflows) {
    const wfPath = `workflows.${wf.id}`;
    // Structural rules: same codes and fixes as the table; messages already name the element.
    for (const s of checkWorkflowStructure(wf)) {
      issues.push({
        severity: s.severity,
        code: s.code as IssueCode,
        message: s.message,
        fix: s.fix,
        path: `${wfPath}.${s.path}`,
        workflowId: wf.id,
      });
    }
    checkVariableNames(wf.variables, `${wfPath}.variables`, add, wf.id);

    // Variables visible in this workflow: the bot's, plus this workflow's own and its inputs.
    const byId = new Map<string, Variable>([...manifestVars, ...wf.variables].map((v) => [v.id, v]));
    const names = {
      bot: new Set(manifestVars.filter((v) => v.scope === "bot").map((v) => v.name)),
      user: new Set(manifestVars.filter((v) => v.scope === "user").map((v) => v.name)),
      conversation: new Set(manifestVars.filter((v) => v.scope === "conversation").map((v) => v.name)),
      workflow: new Set([...wf.variables.map((v) => v.name), ...wf.inputs.map((i) => i.name)]),
    };

    const connected = new Set(wf.edges.map((e) => `${e.from.nodeId}|${e.from.port}`));

    for (const node of wf.nodes) {
      const at = (field: string, cardId?: string): IssueLocation => ({
        path: `${wfPath}.nodes.${node.id}${cardId ? `.cards.${cardId}` : ""}${field ? `.${field}` : ""}`,
        workflowId: wf.id,
        nodeId: node.id,
        ...(cardId ? { cardId } : {}),
      });

      const checkRefs = (refs: Reference[], loc: IssueLocation) => {
        for (const r of refs) {
          if (r.root === "env") {
            if (!configKeys.has(r.name)) add("config_var_unknown", { key: r.name, node: node.name }, loc);
          } else if (!names[r.root].has(r.name)) {
            add("variable_unknown", { ref: `${r.root}.${r.name}`, node: node.name }, loc);
          }
        }
      };
      const template = (text: string | undefined, field: string, cardId?: string) => {
        if (text === undefined || text === "") return;
        const parsed = parseTemplate(text);
        if (!parsed.ok) add("template_syntax", { node: node.name, reason: parsed.reason }, at(field, cardId));
        else checkRefs(parsed.refs, at(field, cardId));
      };
      const expression = (text: string | undefined, field: string, cardId?: string) => {
        if (text === undefined) return;
        const parsed = parseExpression(text);
        if (!parsed.ok) {
          add("expression_syntax", { node: node.name, reason: parsed.reason, expression: text }, at(field, cardId));
        } else checkRefs(parsed.refs, at(field, cardId));
      };
      const code = (source: string, field: string, cardId?: string) => {
        const parsed = parseCodeBody(source);
        if (!parsed.ok)
          add("code_syntax", { node: node.name, line: parsed.line ?? 1, reason: parsed.reason }, at(field, cardId));
        else checkRefs(parsed.refs, at(field, cardId));
      };
      const store = (variableId: string | undefined, expected: VariableType, field: string, cardId?: string) => {
        if (variableId === undefined) return;
        const v = byId.get(variableId);
        if (!v) {
          add("variable_id_unknown", { node: node.name }, at(field, cardId));
          return;
        }
        if (v.scope === "bot") add("variable_read_only", { node: node.name, variable: v.name }, at(field, cardId));
        else if (!compatible(v.type, expected)) {
          add(
            "variable_type_mismatch",
            { variable: v.name, actual: v.type, expected, node: node.name },
            at(field, cardId),
          );
        }
      };
      const message = (m: MessageTemplate | undefined, field: string, cardId?: string) => {
        if (!m) return;
        checkMessage(m, field, cardId, node, at, add, template, expression);
      };
      const callWorkflow = (workflowId: string, field: string, cardId?: string) => {
        const target = workflows.get(workflowId);
        if (!target) {
          add("workflow_unknown", { node: node.name }, at(field, cardId));
          return undefined;
        }
        if (target.kind !== "sub") {
          add("workflow_not_callable", { node: node.name, workflow: target.name }, at(field, cardId));
          return undefined;
        }
        return target;
      };

      switch (node.type) {
        case "standard":
          checkCards(node, wf, connected, add, at);
          for (const card of node.cards) {
            checkCard(card, { at, template, expression, code, store, message, callWorkflow, ctx, node, add, byId });
          }
          break;
        case "autonomous":
          if (node.instructions.trim() === "")
            add("autonomous_instructions_empty", { node: node.name }, at("instructions"));
          else template(node.instructions, "instructions");
          template(node.busyMessage, "busyMessage");
          node.variableAccess.forEach((a, i) => {
            const v = byId.get(a.variableId);
            if (!v) add("variable_id_unknown", { node: node.name }, at(`variableAccess[${i}]`));
            else if (a.mode === "write" && v.scope === "bot") {
              add("variable_read_only", { node: node.name, variable: v.name }, at(`variableAccess[${i}]`));
            }
          });
          node.tools.forEach((tool, i) => {
            const field = `tools[${i}]`;
            if (tool.type === "code") code(tool.source, `${field}.source`);
            if (tool.type === "workflow") callWorkflow(tool.workflowId, `${field}.workflowId`);
            if (tool.type === "kb_search" && ctx.knowledgeBaseIds) {
              if (tool.kbIds.some((id) => !ctx.knowledgeBaseIds?.has(id)))
                add("kb_unknown", { node: node.name }, at(field));
            }
            if (tool.type === "table" && ctx.tableIds && !ctx.tableIds.has(tool.tableId)) {
              add("table_unknown", { node: node.name }, at(field));
            }
          });
          break;
        case "exit": {
          const declared = new Map(wf.outputs.map((o) => [o.name, o]));
          for (const [name, expr] of Object.entries(node.outputs)) {
            if (!declared.has(name))
              add("exit_output_unknown", { node: node.name, output: name }, at(`outputs.${name}`));
            expression(expr, `outputs.${name}`);
          }
          for (const o of wf.outputs) {
            if (o.required && !(o.name in node.outputs))
              add("exit_output_missing", { node: node.name, output: o.name }, at("outputs"));
          }
          break;
        }
        case "end":
          template(node.reason, "reason");
          break;
        default:
          break;
      }
    }
  }
  return issues;
}

type Add = (code: IssueCode, params: Record<string, string | number>, at: IssueLocation) => void;

function checkDefinitionShape(def: BotDefinition, add: Add) {
  const mains = def.workflows.filter((w) => w.kind === "main");
  if (mains.length > 1) add("main_workflow_count", { count: mains.length }, { path: "workflows" });
  const main = def.workflows.find((w) => w.id === def.manifest.mainWorkflowId);
  if (!main || main.kind !== "main") add("main_workflow_missing", {}, { path: "manifest.mainWorkflowId" });
  const errors = def.workflows.filter((w) => w.kind === "error");
  if (errors.length > 1) add("error_workflow_count", { count: errors.length }, { path: "workflows" });
  if (def.manifest.errorWorkflowId !== undefined) {
    const ew = def.workflows.find((w) => w.id === def.manifest.errorWorkflowId);
    if (!ew || ew.kind !== "error") add("error_workflow_missing", {}, { path: "manifest.errorWorkflowId" });
  }
}

/** Ids inside a bot are unique and never reused (architecture §2.2). */
function checkUniqueIds(def: BotDefinition, add: Add) {
  const seen = new Set<string>();
  const check = (id: string, path: string) => {
    if (seen.has(id)) add("duplicate_id", { id }, { path });
    seen.add(id);
  };
  for (const v of def.manifest.variables) check(v.id, "manifest.variables");
  for (const wf of def.workflows) {
    check(wf.id, `workflows.${wf.id}`);
    for (const v of wf.variables) check(v.id, `workflows.${wf.id}.variables`);
    for (const e of wf.edges) check(e.id, `workflows.${wf.id}.edges`);
    for (const n of wf.nodes) {
      check(n.id, `workflows.${wf.id}.nodes.${n.id}`);
      if (n.type === "standard") {
        for (const c of n.cards) {
          check(c.id, `workflows.${wf.id}.nodes.${n.id}.cards.${c.id}`);
          if (c.type === "branch" || c.type === "ai_branch")
            for (const b of c.branches) check(b.id, `workflows.${wf.id}.nodes.${n.id}.cards.${c.id}`);
        }
      }
      if (n.type === "autonomous") {
        for (const t of n.tools) check(t.id, `workflows.${wf.id}.nodes.${n.id}.tools`);
        for (const x of n.exits) check(x.id, `workflows.${wf.id}.nodes.${n.id}.exits`);
      }
    }
  }
}

function checkVariableNames(vars: readonly Variable[], path: string, add: Add, workflowId?: string) {
  const seen = new Set<string>();
  for (const v of vars) {
    const key = `${v.scope}.${v.name}`;
    if (seen.has(key))
      add("variable_name_duplicate", { scope: v.scope, name: v.name }, { path, ...(workflowId ? { workflowId } : {}) });
    seen.add(key);
  }
}

/** Routing outputs left unconnected, and cards after a card that ends the node. */
function checkCards(
  node: Extract<Node, { type: "standard" }>,
  _wf: Workflow,
  connected: ReadonlySet<string>,
  add: Add,
  at: (field: string, cardId?: string) => IssueLocation,
) {
  node.cards.forEach((card, i) => {
    if (card.type === "branch" || card.type === "ai_branch") {
      for (const b of card.branches) {
        if (!connected.has(`${node.id}|card:${card.id}:branch:${b.id}`)) {
          add("routing_port_unconnected", { option: b.label, node: node.name }, at(`branches.${b.id}`, card.id));
        }
      }
    }
    if (card.type === "capture" && card.routeByOption && card.prompt.type === "choice") {
      for (const key of cardPortKeys(card).filter((k) => k.startsWith("option:"))) {
        if (!connected.has(`${node.id}|card:${card.id}:${key}`)) {
          add(
            "routing_port_unconnected",
            { option: key.slice("option:".length), node: node.name },
            at("prompt.options", card.id),
          );
        }
      }
    }
    if (TERMINAL_CARD_TYPES.includes(card.type) && i < node.cards.length - 1) {
      add("card_unreachable", { card: card.label ?? cardName(card), node: node.name }, at("", card.id));
    }
  });
}

const cardName = (card: Card) =>
  ({ handoff: "Hand off to a person", end: "End conversation" })[card.type as "handoff" | "end"] ?? card.type;

function checkMessage(
  m: MessageTemplate,
  field: string,
  cardId: string | undefined,
  node: Node,
  at: (field: string, cardId?: string) => IssueLocation,
  add: Add,
  template: (text: string | undefined, field: string, cardId?: string) => void,
  expression: (text: string | undefined, field: string, cardId?: string) => void,
) {
  switch (m.type) {
    case "text":
      template(m.text, `${field}.text`, cardId);
      break;
    case "image":
      template(m.url, `${field}.url`, cardId);
      template(m.alt, `${field}.alt`, cardId);
      template(m.caption, `${field}.caption`, cardId);
      break;
    case "file":
      template(m.url, `${field}.url`, cardId);
      template(m.name, `${field}.name`, cardId);
      break;
    case "location":
      expression(m.latitude, `${field}.latitude`, cardId);
      expression(m.longitude, `${field}.longitude`, cardId);
      template(m.title, `${field}.title`, cardId);
      template(m.address, `${field}.address`, cardId);
      break;
    case "choice":
    case "dropdown": {
      if (m.text.trim() === "") add("choice_text_empty", { node: node.name }, at(`${field}.text`, cardId));
      else template(m.text, `${field}.text`, cardId);
      const values = new Set<string>();
      m.options.forEach((o, i) => {
        const of = `${field}.options[${i}]`;
        if (o.label.trim() === "" || o.value.trim() === "")
          add("choice_option_empty", { node: node.name }, at(of, cardId));
        template(o.label, `${of}.label`, cardId);
        template(o.value, `${of}.value`, cardId);
        if (values.has(o.value)) add("choice_value_duplicate", { node: node.name, value: o.value }, at(of, cardId));
        values.add(o.value);
      });
      if (m.type === "dropdown") template(m.placeholder, `${field}.placeholder`, cardId);
      break;
    }
    case "card":
    case "carousel": {
      const bodies = m.type === "card" ? [m] : m.items;
      bodies.forEach((b, i) => {
        const bf = m.type === "card" ? field : `${field}.items[${i}]`;
        template(b.title, `${bf}.title`, cardId);
        template(b.subtitle, `${bf}.subtitle`, cardId);
        template(b.imageUrl, `${bf}.imageUrl`, cardId);
        b.actions.forEach((a, j) => {
          template(a.label, `${bf}.actions[${j}].label`, cardId);
          template(a.value, `${bf}.actions[${j}].value`, cardId);
        });
      });
      break;
    }
    case "custom":
      expression(m.data, `${field}.data`, cardId);
      break;
  }
}

interface CardTools {
  at: (field: string, cardId?: string) => IssueLocation;
  template: (text: string | undefined, field: string, cardId?: string) => void;
  expression: (text: string | undefined, field: string, cardId?: string) => void;
  code: (source: string, field: string, cardId?: string) => void;
  store: (variableId: string | undefined, expected: VariableType, field: string, cardId?: string) => void;
  message: (m: MessageTemplate | undefined, field: string, cardId?: string) => void;
  callWorkflow: (workflowId: string, field: string, cardId?: string) => Workflow | undefined;
  ctx: ValidationContext;
  node: Node;
  add: Add;
  byId: ReadonlyMap<string, Variable>;
}

function checkCard(card: Card, t: CardTools) {
  const id = card.id;
  switch (card.type) {
    case "say":
      t.message(card.message, "message", id);
      break;
    case "capture":
      t.message(card.prompt, "prompt", id);
      t.store(card.into, CAPTURE_TYPES[card.kind] ?? "any", "into", id);
      t.template(card.retryMessage, "retryMessage", id);
      t.template(card.extract?.instructions, "extract.instructions", id);
      if (card.validate) {
        t.expression(card.validate.expression, "validate.expression", id);
        t.template(card.validate.message, "validate.message", id);
      }
      break;
    case "branch":
      for (const b of card.branches) t.expression(b.when, `branches.${b.id}.when`, id);
      break;
    case "ai_branch":
      t.template(card.input, "input", id);
      break;
    case "set_variable":
      card.assignments.forEach((a, i) => {
        const v = t.byId.get(a.variableId);
        if (!v) t.add("variable_id_unknown", { node: t.node.name }, t.at(`assignments[${i}].variableId`, id));
        else if (v.scope === "bot")
          t.add(
            "variable_read_only",
            { node: t.node.name, variable: v.name },
            t.at(`assignments[${i}].variableId`, id),
          );
        t.expression(a.value, `assignments[${i}].value`, id);
      });
      break;
    case "code":
      t.code(card.source, "source", id);
      break;
    case "kb_search":
      t.template(card.query, "query", id);
      t.store(card.into, "object", "into", id);
      if (card.answer) {
        t.template(card.answer.instructions, "answer.instructions", id);
        t.store(card.answer.into, "object", "answer.into", id);
      }
      if (t.ctx.knowledgeBaseIds && card.kbIds.some((k) => !t.ctx.knowledgeBaseIds?.has(k))) {
        t.add("kb_unknown", { node: t.node.name }, t.at("kbIds", id));
      }
      break;
    case "table":
      t.template(card.search, "search", id);
      for (const [col, expr] of Object.entries(card.values ?? {})) t.expression(expr, `values.${col}`, id);
      // find returns rows; get, insert, update and upsert return one row.
      t.store(card.into, card.operation === "find" ? "array" : "object", "into", id);
      if (t.ctx.tableIds && !t.ctx.tableIds.has(card.tableId))
        t.add("table_unknown", { node: t.node.name }, t.at("tableId", id));
      break;
    case "call_workflow": {
      const target = t.callWorkflow(card.workflowId, "workflowId", id);
      for (const [name, expr] of Object.entries(card.inputs)) t.expression(expr, `inputs.${name}`, id);
      if (!target) break;
      const inputs = new Map(target.inputs.map((i) => [i.name, i]));
      for (const name of Object.keys(card.inputs)) {
        if (!inputs.has(name))
          t.add(
            "call_input_unknown",
            { node: t.node.name, input: name, workflow: target.name },
            t.at(`inputs.${name}`, id),
          );
      }
      for (const input of target.inputs) {
        if (input.required && !(input.name in card.inputs)) {
          t.add(
            "call_input_missing",
            { node: t.node.name, input: input.name, workflow: target.name },
            t.at("inputs", id),
          );
        }
      }
      const outputs = new Map(target.outputs.map((o) => [o.name, o]));
      for (const [name, variableId] of Object.entries(card.outputs)) {
        const out = outputs.get(name);
        if (!out)
          t.add(
            "call_output_unknown",
            { node: t.node.name, output: name, workflow: target.name },
            t.at(`outputs.${name}`, id),
          );
        t.store(variableId, out?.type ?? "any", `outputs.${name}`, id);
      }
      break;
    }
    case "ai_generate":
      t.template(card.instructions, "instructions", id);
      t.template(card.input, "input", id);
      t.store(card.into, "string", "into", id);
      break;
    case "ai_extract":
      t.template(card.input, "input", id);
      t.template(card.instructions, "instructions", id);
      t.store(card.into, "object", "into", id);
      break;
    case "handoff":
      t.template(card.reason, "reason", id);
      t.message(card.message, "message", id);
      card.include.forEach((v, i) => {
        if (!t.byId.has(v)) t.add("variable_id_unknown", { node: t.node.name }, t.at(`include[${i}]`, id));
      });
      break;
    case "end":
      t.template(card.reason, "reason", id);
      break;
    case "log":
      t.template(card.message, "message", id);
      t.expression(card.data, "data", id);
      break;
    case "set_timeout":
      break;
  }
}
