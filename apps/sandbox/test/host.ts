import { SANDBOX_LIMITS } from "@wakeel/config";
import type { ExecOutcome, SandboxPool } from "../src/pool";
import type { ExecJobInput } from "../src/runner/messages";

/**
 * A stand-in for the worker on the other end of the exec stream: it answers `tool_call` frames with
 * the handler for that name and records every frame. Tests use it with a real pool.
 */

export interface ToolCallFrame {
  t: "tool_call";
  callId: string;
  name: string;
  input: unknown;
}
export interface LogFrame {
  t: "log";
  level: "info" | "warn" | "error";
  args: unknown[];
}
export type HostFrame = ToolCallFrame | LogFrame;

/** A handler result, or a thrown `{ code, message }` for an `ok: false` answer. */
export type Handler = (input: unknown) => unknown | Promise<unknown>;

export class ToolError {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

let n = 0;

export interface HostRun {
  outcome: ExecOutcome;
  frames: HostFrame[];
  calls: ToolCallFrame[];
  logs: LogFrame[];
}

export async function runWithHost(
  pool: SandboxPool,
  source: string,
  options: Partial<Omit<ExecJobInput, "source">> & { handlers?: Record<string, Handler>; answer?: boolean } = {},
): Promise<HostRun> {
  const { handlers = {}, answer = true, ...rest } = options;
  const execId = rest.execId ?? `exec_host_${++n}`;
  const frames: HostFrame[] = [];
  const job: ExecJobInput = {
    execId,
    kind: "code",
    source,
    timeoutMs: 2_000,
    memoryMb: SANDBOX_LIMITS.maxMemoryMb,
    ...rest,
  };
  const outcome = await pool.exec(job, {
    onFrame: (frame) => {
      const f = frame as HostFrame;
      frames.push(f);
      if (f.t !== "tool_call" || !answer) return;
      const handler = handlers[f.name];
      void (async () => {
        try {
          if (!handler) throw new ToolError("tool_failed", `no handler for ${f.name}`);
          const value = await handler(f.input);
          pool.deliver(execId, { t: "tool_result", callId: f.callId, ok: true, value: value ?? null });
        } catch (error) {
          const e = error instanceof ToolError ? error : new ToolError("internal_error", String(error));
          pool.deliver(execId, {
            t: "tool_result",
            callId: f.callId,
            ok: false,
            error: { code: e.code, message: e.message },
          });
        }
      })();
    },
  });
  return {
    outcome,
    frames,
    calls: frames.filter((f): f is ToolCallFrame => f.t === "tool_call"),
    logs: frames.filter((f): f is LogFrame => f.t === "log"),
  };
}

export const errorOf = (outcome: ExecOutcome) => {
  if (outcome.t !== "error") throw new Error(`expected an error frame, got ${JSON.stringify(outcome)}`);
  return outcome;
};

export const resultOf = (outcome: ExecOutcome) => {
  if (outcome.t !== "result") throw new Error(`expected a result frame, got ${JSON.stringify(outcome)}`);
  return outcome;
};
