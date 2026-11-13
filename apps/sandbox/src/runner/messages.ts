/**
 * Messages between the pool (main thread) and a runner (worker thread). Type-only imports keep the
 * runner free of zod and the workspace packages: it loads nothing but QuickJS and its own files.
 */
import type { ExecKind, ExecOutcome } from "../protocol.ts";

/** What a caller asks the pool to run, limits already validated and defaulted. */
export interface ExecJobInput {
  execId: string;
  kind: ExecKind;
  source: string;
  timeoutMs: number;
  memoryMb: number;
}

/** What the pool hands a runner. */
export interface ExecJob extends ExecJobInput {
  /** Epoch milliseconds; the interpreter is interrupted from this moment on. */
  deadline: number;
  stackBytes: number;
}

export interface RunnerData {
  /** One Int32 the pool sets to 1 to cancel the running exec; the interrupt handler reads it. */
  cancel: SharedArrayBuffer;
  /** WASM memory above this, after an exec, retires the runner. */
  wasmMemoryMaxBytes: number;
}

export type MainToWorker =
  | { type: "exec"; job: ExecJob }
  /** A frame from the caller for the running exec, such as a tool result (3.3). */
  | { type: "host"; execId: string; frame: unknown };

export type WorkerToMain =
  | { type: "ready" }
  | { type: "load_failed"; message: string }
  /** A frame for the caller while the exec runs, such as a tool call or a log line (3.3). */
  | { type: "frame"; execId: string; frame: unknown }
  /** `recycle`: the runner must not be reused (host fault, or its WASM memory grew too large). */
  | { type: "done"; execId: string; outcome: ExecOutcome; recycle: boolean };
