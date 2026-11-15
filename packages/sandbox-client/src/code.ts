import {
  AppError,
  type Json,
  newRequestId,
  type Passage,
  type SearchCitations,
  SearchRequest,
} from "@wakeel/contracts";
import type { SandboxClient } from "./client";
import type { ScopePatches } from "./protocol";

/**
 * The adapter behind the engine's code port (task 4.3): one `kind: "code"` exec per Code card. The
 * shapes match `packages/engine/src/ports.ts` structurally, so the engine keeps depending only on
 * its own port (CLAUDE.md §4).
 */

export interface CodeRequest {
  retrievalCitations?: SearchCitations;
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
      retrievalCitations?: SearchCitations;
      value: Json | null;
      patches: Partial<Record<"workflow" | "conversation" | "user" | "turn", Patch>>;
      said: unknown[];
      logs: CodeLog[];
    }
  | {
      ok: false;
      retrievalCitations?: SearchCitations;
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
  kbSearch?(
    request: SearchRequest,
    citations?: SearchCitations,
  ): Promise<{ passages: Passage[]; citations: SearchCitations }>;
  /**
   * Mints the egress capability token for one run (ADR-023 §4), given its exec id. Without it the
   * guest's `fetch` is refused by egress.
   */
  capabilityToken?: (execId: string) => Promise<string | undefined> | string | undefined;
}

/**
 * `say` calls are collected in order. Knowledge calls use the shared bot-scoped search adapter;
 * the remaining platform calls (`tables.*`, `ai.*`) are rejected until their adapters exist.
 */
export function createCodePort(client: SandboxClient, options: CodePortOptions = {}): CodePort {
  return {
    run: async (request) => {
      const said: unknown[] = [];
      let retrievalCitations = request.retrievalCitations;
      const logs: CodeLog[] = [];
      const execId = newRequestId();
      const token = await options.capabilityToken?.(execId);
      const outcome = await client.exec(
        {
          execId,
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
            if (call.name === "kb.search") {
              if (!options.kbSearch) throw new AppError("model_not_configured");
              const raw =
                call.input &&
                typeof call.input === "object" &&
                "query" in call.input &&
                call.input.query &&
                typeof call.input.query === "object"
                  ? call.input.query
                  : call.input;
              const parsed = SearchRequest.safeParse(raw);
              if (!parsed.success) throw new AppError("validation_failed");
              const result = await options.kbSearch(parsed.data, retrievalCitations);
              retrievalCitations = result.citations;
              return result.passages;
            }
            throw new AppError("internal_error", {}, { detail: `${call.name} is not available to code yet` });
          },
          onLog: (frame) => logs.push({ level: frame.level, args: frame.args }),
        },
      );
      if (outcome.t === "error") {
        return {
          ok: false,
          ...(retrievalCitations ? { retrievalCitations } : {}),
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
        ...(retrievalCitations ? { retrievalCitations } : {}),
        value: (outcome.value ?? null) as Json,
        patches: outcome.scopePatches as Partial<Record<keyof ScopePatches, Patch>>,
        said,
        logs,
      };
    },
  };
}
