import { indexDefinition } from "../definition";
import { evalExpressions } from "../expr/evaluate";
import { writeFor } from "../variables";
import type { ExecutorOf } from "./types";

/**
 * Set variable: evaluates every assignment together, then writes them as one step. An expression
 * that gives `undefined` clears the variable (`null`). Types are checked by the engine on apply.
 */
export const setVariable: ExecutorOf<"set_variable"> = async (ctx) => {
  const { assignments } = ctx.card;
  const results = await evalExpressions(
    assignments.map((a) => a.value),
    ctx.scopes,
    ctx.sandbox,
  );
  const index = indexDefinition(ctx.definition);
  const writes = assignments.map((a, i) => {
    const result = results[i];
    if (!result?.ok) throw result?.error;
    return writeFor(index, a.variableId, result.value ?? null);
  });
  return { outcome: { type: "next" }, writes };
};
