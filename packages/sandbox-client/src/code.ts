import { AppError, type Json, newRequestId } from "@wakeel/contracts";
import type { SandboxClient } from "./client";
import type { ScopePatches } from "./protocol";

/**
 * The adapter behind the engine's code port (task 4.3): one `kind: "code"` exec per Code card. The
 * shapes match `packages/engine/src/ports.ts` structurally, so the engine keeps depending only on
 * its own port (CLAUDE.md §4).
 */

export interface CodeRequest {
  source: string;
  scopes: Readonly<Record<string, Json | undefined>>;
  timeoutMs: number;
  memoryMb: number;
  idempotencyKey: string;
  secretKeys: string[];
}

export interface CodeLog {
  level: "info" | "warn" | "error";
  args: unknown[];
}

type Patch = { set?: Record<string, Json>; unset?: string[] };

export type CodeOutcome =
  | {
      ok: true;
      value: Json | null;
      patches: Partial<Record<"workflow" | "conversation" | "user" | "turn", Patch>>;
      said: unknown[];
      logs: CodeLog[];
    }
  | {
      ok: false;
      code: "code_error" | "code_syntax_error" | "code_timeout" | "code_memory_exceeded" | "internal_error";
      message: string;
      line?: number;
      column?: number;
      said: unknown[];
      logs: CodeLog[];
    };

export interface CodePort {
  run(request: CodeRequest): Promise<CodeOutcome>;
}

export interface CodePortOptions {
  /** Mints the egress capability token for one run (ADR-023 §4); without it the guest's fetch is refused. */
  capabilityToken?: () => string | undefined;
}

/**
 * `say` calls are collected in order and answered at once. The other platform calls (`tables.*`,
 * `kb.search`, `ai.*`) arrive with their phases; until then the guest gets an `internal_error`
 * that says so.
 */
export function createCodePort(client: SandboxClient, options: CodePortOptions = {}): CodePort {
  return {
    run: async (request) => {
      const said: unknown[] = [];
      const logs: CodeLog[] = [];
      const token = options.capabilityToken?.();
      const outcome = await client.exec(
        {
          execId: newRequestId(),
          kind: "code",
          source: request.source,
          scopes: request.scopes,
          limits: { timeoutMs: request.timeoutMs, memoryMb: request.memoryMb },
          secretKeys: request.secretKeys,
          ctx: { idempotencyKey: request.idempotencyKey },
          ...(token ? { capabilityToken: token } : {}),
        },
        {
          onToolCall: async (call) => {
            if (call.name === "say") {
              said.push((call.input as { message?: unknown } | null)?.message);
              return null;
            }
            throw new AppError("internal_error", {}, { detail: `${call.name} is not available to code yet` });
          },
          onLog: (frame) => logs.push({ level: frame.level, args: frame.args }),
        },
      );
      if (outcome.t === "error") {
        return {
          ok: false,
          code: outcome.code,
          message: outcome.message,
          ...(outcome.line !== undefined ? { line: outcome.line } : {}),
          ...(outcome.column !== undefined ? { column: outcome.column } : {}),
          said,
          logs,
        };
      }
      return {
        ok: true,
        value: (outcome.value ?? null) as Json,
        patches: outcome.scopePatches as Partial<Record<keyof ScopePatches, Patch>>,
        said,
        logs,
      };
    },
  };
}
