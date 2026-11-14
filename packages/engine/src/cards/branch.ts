import { AppError, type Json } from "@wakeel/contracts";
import { evalExpressions } from "../expr/evaluate";
import { describeJson } from "../variables";
import type { ExecutorOf } from "./types";

/** A condition must give exactly `true` or `false` (architecture §4.6); anything else is an error. */
export function conditionError(expression: string, value: Json | undefined): AppError {
  const got = value === undefined ? "undefined" : `a ${describeJson(value)}`;
  return new AppError("expression_error", {
    expression,
    message: `${expression} gave ${got}; a condition must be true or false`,
  });
}

/**
 * Branch: tests the conditions in order and leaves through the first true one's port; when none
 * is true, the next card runs. All conditions are evaluated together, in one sandbox call at most.
 */
export const branch: ExecutorOf<"branch"> = async (ctx) => {
  const { branches } = ctx.card;
  const results = await evalExpressions(
    branches.map((b) => b.when),
    ctx.scopes,
    ctx.sandbox,
  );
  for (const [i, b] of branches.entries()) {
    const result = results[i];
    if (!result?.ok) throw result?.error;
    if (typeof result.value !== "boolean") throw conditionError(b.when, result.value);
    if (result.value) return { outcome: { type: "goto", port: `branch:${b.id}` } };
  }
  return { outcome: { type: "next" } };
};
