import { AppError, type BotDefinition, type Json, LIMITS } from "@wakeel/contracts";
import { indexDefinition } from "../definition";
import type { CodeLog, CodeOutcome, CodeScope, StepLog } from "../ports";
import { toStepError } from "../step-error";
import type { VariableWrite } from "../variables";
import { checkMessage } from "./render";
import type { ExecutorOf } from "./types";

/**
 * Code: runs the card's JavaScript in the sandbox (architecture §5) through the code port. What the
 * code said with `say(...)` becomes messages, its `log.*` calls become log lines, and its writes to
 * `workflow`, `conversation` and `user` come back as patches by variable name, which become
 * variable writes the engine checks. A run that throws or hits a limit fails the card, so its
 * `error` port is taken when connected; anything it said before failing is still sent.
 */
export const code: ExecutorOf<"code"> = async (ctx) => {
  const { card, definition } = ctx;
  const timeoutMs = Math.max(1, Math.min(card.timeoutMs, ctx.deadline - ctx.now));
  const outcome = await ctx.code.run({
    source: card.source,
    scopes: ctx.scopes,
    timeoutMs,
    memoryMb: LIMITS.codeMemoryMb,
    idempotencyKey: ctx.idempotencyKey,
    secretKeys: definition.manifest.configVars.filter((c) => c.secret).map((c) => c.key),
  });
  const messages = outcome.said.map((m) => checkMessage(withDefaults(m)));
  const logs = outcome.logs.map(toLog);
  if (!outcome.ok) {
    const error = toStepError(runError(outcome, timeoutMs, ctx.turnId), ctx.turnId);
    return { outcome: { type: "fail", error }, messages, logs };
  }
  const { writes, turn } = toWrites(ctx.location.workflowId, definition, outcome.patches, ctx.scopes.turn);
  return {
    outcome: { type: "next" },
    messages,
    logs,
    writes,
    ...(turn ? { turn } : {}),
  };
};

/** `say("text")` and `say({ type: "text", text })` are both accepted, as in the guest API. */
function withDefaults(said: unknown): unknown {
  if (typeof said === "string") return { type: "text", text: said, format: "markdown" };
  return said;
}

function toLog(entry: CodeLog): StepLog {
  const [first, ...rest] = entry.args;
  if (typeof first === "string")
    return rest.length
      ? { level: entry.level, message: first, data: rest as Json }
      : { level: entry.level, message: first };
  return { level: entry.level, message: "", data: entry.args as Json };
}

function runError(outcome: Extract<CodeOutcome, { ok: false }>, timeoutMs: number, turnId: string): AppError {
  const line = outcome.line ?? "?";
  switch (outcome.code) {
    case "code_error":
      return new AppError("code_error", { message: outcome.message, line });
    case "code_syntax_error":
      return new AppError("code_syntax_error", { message: outcome.message, line });
    case "code_timeout":
      return new AppError("code_timeout", { limit: timeoutMs });
    case "code_memory_exceeded":
      return new AppError("code_memory_exceeded", { limit: LIMITS.codeMemoryMb });
    case "internal_error":
      return new AppError("internal_error", { requestId: turnId }, { detail: outcome.message });
  }
}

/**
 * Turns patches by name into writes by variable id. `unset` clears a variable (`null`). Workflow
 * inputs and `user.attributes` are read-only; a name that is not a variable is `variable_not_found`.
 */
function toWrites(
  workflowId: string,
  definition: BotDefinition,
  patches: Partial<Record<CodeScope, { set?: Record<string, Json>; unset?: string[] }>>,
  currentTurn: Json | undefined,
): { writes: VariableWrite[]; turn?: Record<string, Json> } {
  const index = indexDefinition(definition);
  const workflow = index.workflow(workflowId);
  const writes: VariableWrite[] = [];
  for (const scope of ["workflow", "conversation", "user"] as const) {
    const patch = patches[scope];
    if (!patch) continue;
    const declared =
      scope === "workflow"
        ? (workflow?.variables ?? [])
        : definition.manifest.variables.filter((v) => v.scope === scope);
    const changes: [string, Json][] = [
      ...Object.entries(patch.set ?? {}),
      ...(patch.unset ?? []).map((name): [string, Json] => [name, null]),
    ];
    for (const [name, value] of changes) {
      const variable = declared.find((v) => v.name === name);
      if (variable) {
        writes.push({ scope, variableId: variable.id, value });
        continue;
      }
      const readOnly =
        (scope === "workflow" && workflow?.inputs.some((i) => i.name === name)) ||
        (scope === "user" && name === "attributes");
      if (readOnly) throw new AppError("write_not_allowed", { variable: `${scope}.${name}` });
      throw new AppError("variable_not_found", { name: `${scope}.${name}` });
    }
  }
  const turnPatch = patches.turn;
  if (!turnPatch) return { writes };
  const turn: Record<string, Json> = { ...(currentTurn as Record<string, Json> | undefined) };
  Object.assign(turn, turnPatch.set ?? {});
  for (const name of turnPatch.unset ?? []) delete turn[name];
  return { writes, turn };
}
