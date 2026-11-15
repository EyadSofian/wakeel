/**
 * Messages between the pool (main thread) and a runner (worker thread). Type-only imports keep the
 * runner free of zod and the workspace packages: it loads nothing but QuickJS and its own files.
 */
import type { CallAnswer, GuestFetchRequest } from "../guest/index.ts";
import type { ExecKind, ExecOutcome } from "../protocol.ts";

/** What a caller asks the pool to run, limits already validated and defaulted. */
/** A builder tool as the guest sees it: a function, or an object of table operations (ADR-032 §1). */
export interface BuilderTool {
  name: string;
  operations?: string[];
}

export interface ExecJobInput {
  execId: string;
  kind: ExecKind;
  source: string;
  timeoutMs: number;
  memoryMb: number;
  /** `bot`, `user`, `conversation`, `workflow`, `event`, `env`, `turn` as JSON (§5.2). */
  scopes?: Record<string, unknown>;
  /** `env` keys whose values are redacted (ADR-023 §5). */
  secretKeys?: string[];
  /** Tables the code may use as `tables.<name>` (ADR-023 §3). */
  tables?: string[];
  /** `autonomy_run` only: the node's tools, as `tools.<name>` (ADR-032 §1). */
  tools?: BuilderTool[];
  /** `ctx.idempotencyKey`; the exec id when absent (ADR-022). */
  idempotencyKey?: string;
  /** Sent to egress for the guest `fetch`. Stays on the pool's thread; never reaches a runner. */
  capabilityToken?: string;
}

/** One expression of a batch as the runner gets it: parsed on the pool's thread first (ADR-018). */
export interface BatchExpression {
  source: string;
  /** Why the text is not a single expression; the runner does not evaluate it. */
  invalid?: string;
}

/** What the pool hands a runner. */
export interface ExecJob extends Omit<ExecJobInput, "capabilityToken" | "scopes" | "secretKeys"> {
  /**
   * The scopes as JSON text, made on the pool's thread. A value that cannot become JSON there (too
   * deeply nested, a cycle) is refused before any runner is involved.
   */
  scopesText: string;
  /** Values to redact, longest first: the secret `env` values and their JSON-escaped forms. */
  secrets: string[];
  /**
   * Bytes of the module's WASM memory held back for this exec, so a caller's lower `memoryMb` is as
   * real as the maximum: the ceiling is fixed per module (docs/security/sandbox-review.md §2).
   */
  reserveBytes: number;
  /** Epoch milliseconds; the interpreter is interrupted from this moment on. */
  deadline: number;
  stackBytes: number;
  /** `kind: "expressions"` only. */
  expressions?: BatchExpression[];
}

export interface RunnerData {
  /** One Int32 the pool sets to 1 to cancel the running exec; the interrupt handler reads it. */
  cancel: SharedArrayBuffer;
  /** The QuickJS module's WASM memory: it starts at `initialBytes` and can never pass `maximumBytes`. */
  wasmMemory: { initialBytes: number; maximumBytes: number };
}

export type MainToWorker =
  | { type: "exec"; job: ExecJob }
  /** A frame from the caller for the running exec, such as a tool result. */
  | { type: "host"; execId: string; frame: unknown }
  /** The answer to a guest `fetch` the runner asked for. */
  | { type: "fetch_result"; execId: string; fetchId: number; answer: CallAnswer };

export type WorkerToMain =
  | { type: "ready" }
  | { type: "load_failed"; message: string }
  /** A frame for the caller while the exec runs: a tool call or a log line. */
  | { type: "frame"; execId: string; frame: unknown }
  /** A guest `fetch` for the pool to send through egress. */
  | { type: "fetch"; execId: string; fetchId: number; request: GuestFetchRequest }
  /** `recycle`: the runner must not be reused (host fault, or its WASM memory grew too large). */
  | { type: "done"; execId: string; outcome: ExecOutcome; recycle: boolean };
