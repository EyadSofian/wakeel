import { AppError, type Json, newRequestId } from "@wakeel/contracts";
import type { SandboxClient } from "./client";
import type { BuilderTool } from "./protocol";

/**
 * The adapter for an Autonomous Node's `:::run` block (ADR-032 §1): one `kind: "autonomy_run"` exec.
 * The guest sees only the node's tools (`tools.<name>`), the scopes and `memo`; every tool call comes
 * back here as `tool.<name>[.<operation>]` and is answered by `onTool`.
 */

type Patch = { set?: Record<string, Json>; unset?: string[] };

export interface AutonomyRunRequest {
  source: string;
  /** `workflow`, `conversation`, `user`, `turn`, `memo` (writable) and `bot`, `event`, `env` (read-only). */
  scopes: Readonly<Record<string, Json | undefined>>;
  tools: BuilderTool[];
  timeoutMs: number;
  memoryMb: number;
  idempotencyKey: string;
  /**
   * Answers one tool call. Throw an `AppError` (`tool_input_invalid`, `tool_failed`) for a failure
   * the model should read; its title reaches the guest as the error's message.
   */
  onTool(call: { tool: string; operation?: string; input: Json }): Promise<Json>;
}

export type AutonomyRunOutcome =
  | {
      ok: true;
      /** `null` when the block returned nothing. */
      value: Json | null;
      patches: Partial<Record<"workflow" | "conversation" | "user" | "turn" | "memo", Patch>>;
      logs: { level: "info" | "warn" | "error"; args: unknown[] }[];
    }
  | {
      ok: false;
      code: "code_error" | "code_syntax_error" | "code_timeout" | "code_memory_exceeded" | "internal_error";
      message: string;
      line?: number;
      logs: { level: "info" | "warn" | "error"; args: unknown[] }[];
    };

export interface AutonomyRunPort {
  run(request: AutonomyRunRequest): Promise<AutonomyRunOutcome>;
}

/** Runs model-written code. The guest has no `fetch`, so no capability token is minted (ADR-032 §1). */
export function createAutonomyRunPort(client: SandboxClient): AutonomyRunPort {
  return {
    run: async (request) => {
      const logs: AutonomyRunOutcome["logs"] = [];
      const outcome = await client.exec(
        {
          execId: newRequestId(),
          kind: "autonomy_run",
          source: request.source,
          scopes: request.scopes,
          toolManifest: request.tools,
          limits: { timeoutMs: request.timeoutMs, memoryMb: request.memoryMb },
          ctx: { idempotencyKey: request.idempotencyKey },
        },
        {
          onToolCall: async (call) => {
            const parts = call.name.split(".");
            if (parts[0] !== "tool" || !parts[1])
              throw new AppError("internal_error", {}, { detail: `${call.name} is not a tool call` });
            return request.onTool({
              tool: parts[1],
              ...(parts[2] ? { operation: parts[2] } : {}),
              input: (call.input ?? null) as Json,
            });
          },
          onLog: (frame) => logs.push({ level: frame.level, args: frame.args }),
        },
      );
      if (outcome.t === "error")
        return {
          ok: false,
          code: outcome.code,
          message: outcome.message,
          ...(outcome.line !== undefined ? { line: outcome.line } : {}),
          logs,
        };
      return {
        ok: true,
        value: (outcome.value ?? null) as Json,
        patches: outcome.scopePatches as Partial<Record<"workflow" | "conversation" | "user" | "turn" | "memo", Patch>>,
        logs,
      };
    },
  };
}
