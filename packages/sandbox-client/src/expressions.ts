import { AppError, type ErrorCode, type Json, newRequestId } from "@wakeel/contracts";
import type { SandboxClient } from "./client";
import { ExpressionOutcomeFrame } from "./protocol";

/**
 * The adapter behind the engine's expression port (ADR-018): one `kind: "expressions"` exec per
 * batch. The shapes match `packages/engine/src/expr/sandbox-port.ts` structurally, so the engine
 * keeps depending only on its own port (CLAUDE.md §4).
 */

export interface ExpressionBatch {
  expressions: readonly string[];
  scopes: Readonly<Record<string, Json | undefined>>;
}

export type ExpressionOutcome = { ok: true; value: Json | undefined } | { ok: false; message: string };

export interface ExpressionPort {
  /** One outcome per expression, in order. Rejects only when the batch as a whole could not run. */
  evalExpressions(batch: ExpressionBatch): Promise<ExpressionOutcome[]>;
}

export interface ExpressionPortOptions {
  /** Deadline for one batch. ADR-018 proposes 1 s. */
  timeoutMs?: number;
  memoryMb?: number;
}

/** ADR-018 §3 proposes a 1 s deadline per batch until `limits.ts` carries one. */
const DEFAULT_TIMEOUT_MS = 1_000;

export function createExpressionPort(client: SandboxClient, options: ExpressionPortOptions = {}): ExpressionPort {
  return {
    evalExpressions: async (batch) => {
      if (batch.expressions.length === 0) return [];
      const limits: { timeoutMs: number; memoryMb?: number } = { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
      if (options.memoryMb !== undefined) limits.memoryMb = options.memoryMb;
      const outcome = await client.exec(
        {
          execId: newRequestId(),
          kind: "expressions",
          source: JSON.stringify(batch.expressions),
          scopes: batch.scopes,
          limits,
        },
        {
          // ADR-018 §3: an expression batch has no platform calls; any would be a protocol error.
          onToolCall: () => Promise.reject(new AppError("internal_error")),
        },
      );
      if (outcome.t === "error") {
        const code: ErrorCode = outcome.code;
        throw new AppError(code, { limit: limits.timeoutMs, message: outcome.message }, { detail: outcome.message });
      }
      if (Object.keys(outcome.scopePatches).length > 0) {
        throw new AppError("internal_error", {}, { detail: "an expression batch returned scope patches" });
      }
      const values = Array.isArray(outcome.value) ? outcome.value : undefined;
      if (!values || values.length !== batch.expressions.length) {
        throw new AppError(
          "internal_error",
          {},
          { detail: "an expression batch returned the wrong number of outcomes" },
        );
      }
      return values.map((raw) => {
        const parsed = ExpressionOutcomeFrame.safeParse(raw);
        if (!parsed.success) throw new AppError("internal_error", {}, { detail: "an expression outcome is not valid" });
        const o = parsed.data;
        return o.ok
          ? { ok: true as const, value: o.value as Json | undefined }
          : { ok: false as const, message: o.message };
      });
    },
  };
}
