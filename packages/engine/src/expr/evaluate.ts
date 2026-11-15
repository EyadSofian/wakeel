import { AppError, type Json, parseExpression } from "@wakeel/contracts";
import { parsePath, resolvePath } from "./path";
import type { ExpressionOutcome, ExpressionScopes, SandboxPort } from "./sandbox-port";

/** The value of one expression, or the `expression_error` it produced. */
export type ExpressionResult = { ok: true; value: Json | undefined } | { ok: false; error: AppError };

function failure(expression: string, message: string, cause?: unknown): ExpressionResult {
  return {
    ok: false,
    error: new AppError("expression_error", { expression, message }, cause === undefined ? {} : { cause }),
  };
}

function batchFailureMessage(e: unknown): string {
  if (e instanceof AppError) return e.title;
  return `The sandbox could not run it: ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * Evaluates expressions for one card (architecture §4.6). Pure property paths are read from the
 * scopes directly. Everything else goes to the sandbox in a single batch, each distinct source
 * once, and if nothing needs the sandbox, it is not called. Returns one result per source, in
 * order. A failure is an `expression_error` naming the expression and the message, and one
 * failing expression never hides the others.
 */
export async function evalExpressions(
  sources: readonly string[],
  scopes: ExpressionScopes,
  sandbox: SandboxPort,
): Promise<ExpressionResult[]> {
  const results: ExpressionResult[] = new Array(sources.length);
  // Distinct sandbox sources, each with the positions that asked for it.
  const pending = new Map<string, number[]>();

  sources.forEach((raw, i) => {
    const source = raw.trim();
    const path = parsePath(source);
    if (path) {
      const resolved = resolvePath(path, scopes);
      if (resolved.kind === "value") {
        results[i] = { ok: true, value: resolved.value };
        return;
      }
      if (resolved.kind === "fail") {
        results[i] = failure(source, resolved.message);
        return;
      }
    } else {
      const parsed = parseExpression(source);
      if (!parsed.ok) {
        results[i] = failure(source, `The expression does not parse: ${parsed.reason}`);
        return;
      }
    }
    const positions = pending.get(source);
    if (positions) positions.push(i);
    else pending.set(source, [i]);
  });

  if (pending.size === 0) return results;

  const expressions = [...pending.keys()];
  const outcomes = await runBatch(sandbox, expressions, scopes);
  expressions.forEach((source, k) => {
    const outcome = outcomes[k] as ExpressionOutcome | BatchFailure;
    const result: ExpressionResult = !("ok" in outcome)
      ? failure(source, outcome.message, outcome.cause)
      : outcome.ok
        ? { ok: true, value: outcome.value }
        : failure(source, outcome.message);
    for (const i of pending.get(source) as number[]) results[i] = result;
  });
  return results;
}

interface BatchFailure {
  message: string;
  cause: unknown;
}

/** Calls the port once. A batch that could not run gives every expression the same failure. */
async function runBatch(
  sandbox: SandboxPort,
  expressions: string[],
  scopes: ExpressionScopes,
): Promise<(ExpressionOutcome | BatchFailure)[]> {
  let outcomes: ExpressionOutcome[];
  try {
    outcomes = await sandbox.evalExpressions({ expressions, scopes });
  } catch (e) {
    return expressions.map(() => ({ message: batchFailureMessage(e), cause: e }));
  }
  if (outcomes.length === expressions.length) return outcomes;
  // A misaligned answer would pin values on the wrong expressions; refuse it as a whole.
  const mismatch = new Error(`it returned ${outcomes.length} results for ${expressions.length} expressions`);
  return expressions.map(() => ({ message: batchFailureMessage(mismatch), cause: mismatch }));
}
