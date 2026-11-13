import { SANDBOX_LIMITS } from "@wakeel/config";
import { z } from "zod";

/**
 * The `POST /exec` stream (architecture §5.1): newline-delimited JSON in both directions. The first
 * line the caller sends is an exec request; later lines answer tool calls. The service answers with
 * zero or more `tool_call` and `log` frames and ends with exactly one `result` or `error` frame.
 *
 * The service (`apps/sandbox`) and its callers both import these schemas from here (ADR-019 §10).
 * They are internal service frames, not public contracts.
 */

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

export const ExecKind = z.enum(["code", "expressions", "autonomy_run"]);
export type ExecKind = z.infer<typeof ExecKind>;

export const ExecLimits = z.object({
  timeoutMs: z.number().int().min(1).max(SANDBOX_LIMITS.maxTimeoutMs).default(SANDBOX_LIMITS.defaultTimeoutMs),
  memoryMb: z.number().int().min(1).max(SANDBOX_LIMITS.maxMemoryMb).default(SANDBOX_LIMITS.defaultMemoryMb),
});
export type ExecLimits = z.infer<typeof ExecLimits>;

/** Table names as `tables.<name>` shows them: identifiers only. */
const TableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);

export const ExecRequestFrame = z.object({
  execId: z.string().min(1).max(200),
  kind: ExecKind,
  /** The code body; for `expressions`, a JSON array of expression sources (ADR-018 §2). */
  source: z.string(),
  /** `workflow`, `conversation`, `user`, `bot`, `event`, `env`, `turn` (§5.2). */
  scopes: z.record(z.string(), z.unknown()).default({}),
  /** Builder tools, for `autonomy_run` (Phase 6). Not exposed to `code` or `expressions` (ADR-023 §3). */
  toolManifest: z.array(z.unknown()).default([]),
  limits: ExecLimits.default({
    timeoutMs: SANDBOX_LIMITS.defaultTimeoutMs,
    memoryMb: SANDBOX_LIMITS.defaultMemoryMb,
  }),
  /** Passed on to egress by the guest `fetch` (ADR-023 §4). A credential: never logged or echoed. */
  capabilityToken: z.string().max(2048).optional(),
  /** `env` keys whose values are secret and redacted from logs (ADR-023 §5). */
  secretKeys: z.array(z.string().min(1).max(256)).max(500).default([]),
  /** Tables the code may use (ADR-023 §3). */
  tables: z.array(TableName).max(500).default([]),
  /** `ctx` for the guest; the idempotency key is the exec id when absent (ADR-022, ADR-023 §5). */
  ctx: z.object({ idempotencyKey: z.string().min(1).max(500) }).optional(),
});
export type ExecRequestFrame = z.infer<typeof ExecRequestFrame>;
/** What a caller writes: defaults filled in by the service. */
export type ExecRequestFrameInput = z.input<typeof ExecRequestFrame>;

/** The caller's answer to a `tool_call` frame. */
export const ToolResultFrame = z.discriminatedUnion("ok", [
  z.object({ t: z.literal("tool_result"), callId: z.string().min(1), ok: z.literal(true), value: z.unknown() }),
  z.object({
    t: z.literal("tool_result"),
    callId: z.string().min(1),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type ToolResultFrame = z.infer<typeof ToolResultFrame>;

/** Platform calls the guest makes over the stream (ADR-023 §3). */
export const ToolCallName = z.enum([
  "say",
  "tables.find",
  "tables.get",
  "tables.insert",
  "tables.update",
  "tables.upsert",
  "tables.delete",
  "kb.search",
  "ai.generate",
  "ai.extract",
  "ai.classify",
]);
export type ToolCallName = z.infer<typeof ToolCallName>;

export const ToolCallFrame = z.object({
  t: z.literal("tool_call"),
  callId: z.string().min(1),
  name: ToolCallName,
  input: z.unknown(),
});
export type ToolCallFrame = z.infer<typeof ToolCallFrame>;

/** A guest log line, secrets already redacted (ADR-023 §6). */
export const LogFrame = z.object({
  t: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  args: z.array(z.unknown()),
});
export type LogFrame = z.infer<typeof LogFrame>;

export const ExecStats = z.object({
  /** Creating the fresh runtime and context, applying the limits and installing the guest API. */
  setupMs: z.number().nonnegative(),
  /** Evaluating the code until its promise settled, including serialising the value. */
  runMs: z.number().nonnegative(),
});
export type ExecStats = z.infer<typeof ExecStats>;

/** Writes to one scope, whole top-level variables at a time (ADR-023 §2). */
export const ScopePatch = z.strictObject({
  set: z.record(z.string(), z.unknown()).optional(),
  unset: z.array(z.string()).optional(),
});
export type ScopePatch = z.infer<typeof ScopePatch>;

export const ScopePatches = z.strictObject({
  workflow: ScopePatch.optional(),
  conversation: ScopePatch.optional(),
  user: ScopePatch.optional(),
  turn: ScopePatch.optional(),
});
export type ScopePatches = z.infer<typeof ScopePatches>;

export const ResultFrame = z.object({
  t: z.literal("result"),
  /** The JSON value the code returned; `null` when it returned nothing. */
  value: z.unknown(),
  /** Variable writes, diffed after the run. Always empty for `expressions`. */
  scopePatches: ScopePatches,
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
  /** The guest's own message for `code_error` and `code_syntax_error`, secrets redacted. */
  message: z.string(),
  /** 1-based, in the caller's source. */
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
export type ErrorFrame = z.infer<typeof ErrorFrame>;

export const ExecOutcome = z.discriminatedUnion("t", [ResultFrame, ErrorFrame]);
export type ExecOutcome = z.infer<typeof ExecOutcome>;

/** Every frame the service sends. */
export const ServiceFrame = z.discriminatedUnion("t", [ToolCallFrame, LogFrame, ResultFrame, ErrorFrame]);
export type ServiceFrame = z.infer<typeof ServiceFrame>;

/** One outcome per expression in a batch (ADR-018 §2): no `value` key means `undefined`. */
export const ExpressionOutcomeFrame = z.union([
  z.strictObject({ ok: z.literal(true), value: z.unknown().optional() }),
  z.strictObject({ ok: z.literal(false), message: z.string() }),
]);
