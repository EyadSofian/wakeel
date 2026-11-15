import { BUILT_IN_SCOPES, type Json, VariableScope } from "@wakeel/contracts";

/** The objects an expression can name at its root (architecture §4.5). */
export const EXPRESSION_ROOTS = [...VariableScope.options, ...BUILT_IN_SCOPES] as const;
export type ExpressionRoot = (typeof EXPRESSION_ROOTS)[number];

/** Scope values as the engine holds them: plain JSON, keyed by root. */
export type ExpressionScopes = { readonly [K in ExpressionRoot]?: Json };

/** One batch for the sandbox: distinct, non-path expression sources and the scopes they read. */
export interface ExpressionBatch {
  expressions: readonly string[];
  scopes: Readonly<ExpressionScopes>;
}

/** The result of one expression in a batch. `value` is absent when the expression gave `undefined`. */
export type ExpressionOutcome = { ok: true; value: Json | undefined } | { ok: false; message: string };

/**
 * The engine's only way to evaluate builder expressions (ADR-003, ADR-018). The real adapter is the
 * sandbox client (task 3.3); the engine itself never evaluates builder text.
 */
export interface SandboxPort {
  /**
   * Evaluates every expression against read-only scopes and returns one outcome per expression, in
   * request order. Rejects only when the batch as a whole could not run (deadline, memory, the
   * sandbox being unavailable).
   */
  evalExpressions(batch: ExpressionBatch): Promise<ExpressionOutcome[]>;
}
