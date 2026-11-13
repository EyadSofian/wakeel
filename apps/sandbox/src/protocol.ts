import { SANDBOX_LIMITS } from "@wakeel/config";
import { z } from "zod";

/**
 * The `POST /exec` stream (architecture §5.1): newline-delimited JSON in both directions. The first
 * line the caller sends is an exec request; later lines answer tool calls. The service answers with
 * zero or more `tool_call` and `log` frames (task 3.3) and ends with exactly one `result` or
 * `error` frame.
 *
 * These schemas move to `packages/sandbox-client` when the typed client is built (task 3.3,
 * ADR-019); until then they live here and nothing outside this app imports them.
 */

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

export const ExecKind = z.enum(["code", "expressions", "autonomy_run"]);
export type ExecKind = z.infer<typeof ExecKind>;

export const ExecLimits = z.object({
  timeoutMs: z.number().int().min(1).max(SANDBOX_LIMITS.maxTimeoutMs).default(SANDBOX_LIMITS.defaultTimeoutMs),
  memoryMb: z.number().int().min(1).max(SANDBOX_LIMITS.maxMemoryMb).default(SANDBOX_LIMITS.defaultMemoryMb),
});
export type ExecLimits = z.infer<typeof ExecLimits>;

export const ExecRequestFrame = z.object({
  execId: z.string().min(1).max(200),
  kind: ExecKind,
  source: z.string(),
  /** `workflow`, `conversation`, `user`, `bot`, `event`, `env`, `turn`: injected by the guest API (3.3). */
  scopes: z.record(z.string(), z.unknown()).default({}),
  /** Tools the guest may call (3.3); every tool is listed, none is implicit. */
  toolManifest: z.array(z.unknown()).default([]),
  limits: ExecLimits.default({
    timeoutMs: SANDBOX_LIMITS.defaultTimeoutMs,
    memoryMb: SANDBOX_LIMITS.defaultMemoryMb,
  }),
  /** Passed on to egress by the guest `fetch` (3.3). A credential: never logged or echoed. */
  capabilityToken: z.string().optional(),
});
export type ExecRequestFrame = z.infer<typeof ExecRequestFrame>;

/** The caller's answer to a `tool_call` frame (3.3). */
export const ToolResultFrame = z.discriminatedUnion("ok", [
  z.object({ t: z.literal("tool_result"), callId: z.string().min(1), ok: z.literal(true), value: z.unknown() }),
  z.object({ t: z.literal("tool_result"), callId: z.string().min(1), ok: z.literal(false), error: z.unknown() }),
]);
export type ToolResultFrame = z.infer<typeof ToolResultFrame>;

export const ExecStats = z.object({
  /** Creating the fresh runtime and context and applying the limits. */
  setupMs: z.number().nonnegative(),
  /** Evaluating the code until its promise settled, including serialising the value. */
  runMs: z.number().nonnegative(),
});
export type ExecStats = z.infer<typeof ExecStats>;

export const ResultFrame = z.object({
  t: z.literal("result"),
  /** The JSON value the code returned; `null` when it returned nothing. */
  value: z.unknown(),
  /** Variable writes, diffed after the run (3.3). Empty until the guest API exists. */
  scopePatches: z.record(z.string(), z.unknown()),
  stats: ExecStats,
});
export type ResultFrame = z.infer<typeof ResultFrame>;

/** The codes an execution can end with; titles and fixes are in `errors.ts`. */
export const ExecErrorCode = z.enum([
  "code_error",
  "code_syntax_error",
  "code_timeout",
  "code_memory_exceeded",
  "internal_error",
]);
export type ExecErrorCode = z.infer<typeof ExecErrorCode>;

export const ErrorFrame = z.object({
  t: z.literal("error"),
  code: ExecErrorCode,
  /** The guest's own message for `code_error` and `code_syntax_error`; a plain description otherwise. */
  message: z.string(),
  /** 1-based, in the caller's source. */
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

export const ExecOutcome = z.discriminatedUnion("t", [ResultFrame, ErrorFrame]);
export type ExecOutcome = z.infer<typeof ExecOutcome>;
