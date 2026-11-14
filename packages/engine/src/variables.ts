import {
  AppError,
  type ConversationState,
  type EventScope,
  type Frame,
  type Json,
  STATE_MAX_BYTES,
  type Variable,
  type VariableType,
} from "@wakeel/contracts";
import type { DefinitionIndex } from "./definition";
import type { ExpressionScopes } from "./expr/sandbox-port";

/** The kind of a JSON value, in the words `variable_type_mismatch` uses. */
export function describeJson(value: Json | undefined): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Whether a value fits a declared type (architecture §4.5). `null` clears a variable of any type.
 * Dates are ISO 8601 strings. The optional JSON shape of `object` and `array` variables is not
 * checked here.
 */
export function fitsType(value: Json, type: VariableType, enumValues?: readonly string[]): boolean {
  if (value === null || type === "any") return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
    case "enum":
      return typeof value === "string" && (enumValues ?? []).includes(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Throws `variable_type_mismatch` when `value` does not fit. */
export function checkType(name: string, value: Json, type: VariableType, enumValues?: readonly string[]): void {
  if (!fitsType(value, type, enumValues))
    throw new AppError("variable_type_mismatch", { variable: name, expected: type, received: describeJson(value) });
}

/** Mutable holders the engine writes variables into during a turn. */
export interface VariableStores {
  state: ConversationState;
  user: { vars: Record<string, Json> };
}

export interface VariableWrite {
  scope: "user" | "conversation" | "workflow";
  variableId: string;
  value: Json;
}

/**
 * Validates every write against the variable's declaration, then applies them all, so a step
 * either changes every variable it names or none. Workflow variables are written to `frame`, which
 * must belong to the workflow that declares them. Returns the scopes that changed.
 */
export function applyWrites(
  index: DefinitionIndex,
  stores: VariableStores,
  frame: Frame | undefined,
  writes: readonly VariableWrite[],
): Set<VariableWrite["scope"]> {
  const checked = writes.map((w) => {
    const entry = index.variable(w.variableId);
    if (!entry || entry.variable.scope !== w.scope) throw new AppError("variable_not_found", { name: w.variableId });
    if (w.scope === "workflow" && entry.workflowId !== frame?.workflowId)
      throw new AppError("variable_not_found", { name: entry.variable.name });
    checkType(entry.variable.name, w.value, entry.variable.type, entry.variable.enumValues);
    return w;
  });
  const changed = new Set<VariableWrite["scope"]>();
  for (const w of checked) {
    changed.add(w.scope);
    if (w.scope === "user") stores.user.vars[w.variableId] = w.value;
    else if (w.scope === "conversation") stores.state.conversationVars[w.variableId] = w.value;
    else (frame as Frame).vars[w.variableId] = w.value;
  }
  return changed;
}

/**
 * The write that delivers a value into the variable `variableId`, wherever it is declared. Bot
 * variables are read-only at run time (§4.5).
 */
export function writeFor(index: DefinitionIndex, variableId: string, value: Json): VariableWrite {
  const entry = index.variable(variableId);
  if (!entry) throw new AppError("variable_not_found", { name: variableId });
  if (entry.variable.scope === "bot") throw new AppError("write_not_allowed", { variable: entry.variable.name });
  return { scope: entry.variable.scope, variableId, value };
}

function byName(variables: readonly Variable[], values: Readonly<Record<string, Json>>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const v of variables) {
    const value = v.id in values ? values[v.id] : v.default;
    if (value !== undefined) out[v.name] = value;
  }
  return out;
}

export interface ScopeSources {
  index: DefinitionIndex;
  state: ConversationState;
  user: { vars: Record<string, Json>; attributes: Record<string, Json> };
  frame: Frame | undefined;
  event: EventScope;
  env: Record<string, Json>;
  turn: Record<string, Json>;
}

/**
 * The objects expressions and code read (§4.5), keyed by name. Values come from the stores, or
 * from each variable's default when it was never written.
 */
export function buildScopes(s: ScopeSources): ExpressionScopes {
  const manifest = s.index.definition.manifest.variables;
  const ofScope = (scope: Variable["scope"]) => manifest.filter((v) => v.scope === scope);
  const workflow = s.frame ? s.index.workflow(s.frame.workflowId) : undefined;
  return {
    bot: byName(ofScope("bot"), {}),
    user: { ...byName(ofScope("user"), s.user.vars), attributes: s.user.attributes },
    conversation: byName(ofScope("conversation"), s.state.conversationVars),
    workflow: s.frame ? { ...byName(workflow?.variables ?? [], s.frame.vars), ...s.frame.inputs } : {},
    event: s.event as unknown as Json,
    env: s.env,
    turn: s.turn,
  };
}

const encoder = new TextEncoder();

/** Serialised size in UTF-8 bytes; Arabic text takes two bytes a letter, so characters undercount. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * When the state is over 256 KB (§4.1), the `state_too_large` error naming its three largest
 * variables; otherwise undefined.
 */
export function stateSizeError(index: DefinitionIndex, state: ConversationState): AppError | undefined {
  if (jsonBytes(state) <= STATE_MAX_BYTES) return undefined;
  const sizes: { name: string; bytes: number }[] = [];
  const nameOf = (id: string) => index.variable(id)?.variable.name ?? id;
  for (const [id, value] of Object.entries(state.conversationVars))
    sizes.push({ name: `conversation.${nameOf(id)}`, bytes: jsonBytes(value) });
  for (const frame of state.stack) {
    for (const [id, value] of Object.entries(frame.vars))
      sizes.push({ name: `workflow.${nameOf(id)}`, bytes: jsonBytes(value) });
    for (const [name, value] of Object.entries(frame.inputs))
      sizes.push({ name: `workflow.${name}`, bytes: jsonBytes(value) });
  }
  const largest = sizes
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((s) => s.name)
    .join(", ");
  return new AppError("state_too_large", { limit: "256 KB", largest: largest || "none" });
}
