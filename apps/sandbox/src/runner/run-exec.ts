/**
 * One execution in a fresh QuickJS runtime (architecture §5.1, ADR-003). Runs inside a runner
 * thread; imports only QuickJS types and relative files.
 *
 * Every handle taken here is disposed before the runtime is freed: QuickJS asserts that its heap is
 * empty when a runtime is freed and aborts the whole WASM module otherwise. Any exception from the
 * QuickJS host layer itself therefore retires the runner (`recycle`) instead of reusing it.
 */
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";
import type { GuestApi, GuestSession, HostChannel } from "../guest/index.ts";
import type { ErrorFrame, ExecOutcome } from "../protocol.ts";
import type { ExecJob } from "./messages.ts";

/** File name the guest's stack traces and syntax errors refer to. */
export const SOURCE_NAME = "code.js";

/**
 * Code runs as the body of an async function so it can `await` and `return`. The prefix shares the
 * first line with the caller's code, so line numbers need no mapping; only columns on line 1 shift.
 */
const PREFIX = "(async () => {";
const SUFFIX = "\n})()";

/** Pending jobs run per batch; the deadline and cancel flag are checked between batches. */
const JOB_BATCH = 512;

export interface RunControl {
  /** True once the pool has cancelled this exec (the caller went away). */
  cancelled(): boolean;
}

export interface RunReport {
  outcome: ExecOutcome;
  /** The runner must be replaced: its QuickJS module may be in an undefined state. */
  recycle: boolean;
}

/** Runs `job` and reports how it ended. Never throws. */
export async function runExec(
  quickjs: QuickJSWASMModule,
  job: ExecJob,
  control: RunControl,
  guest: GuestApi,
  channel: HostChannel,
): Promise<RunReport> {
  const started = performance.now();
  if (job.kind !== "code") {
    return internal(`kind ${job.kind} has no guest layer yet`, false);
  }

  const runtime = quickjs.newRuntime();
  const ctx = runtime.newContext();
  const held: QuickJSHandle[] = [];
  let session: GuestSession | undefined;
  let report: RunReport;
  try {
    runtime.setMemoryLimit(job.memoryMb * 1024 * 1024);
    runtime.setMaxStackSize(job.stackBytes);
    runtime.setInterruptHandler(() => Date.now() >= job.deadline || control.cancelled());

    // Take the intrinsic JSON.stringify before any guest code can replace it.
    const json = ctx.getProp(ctx.global, "JSON");
    const stringify = ctx.getProp(json, "stringify");
    json.dispose();
    held.push(stringify);

    session = guest.install(ctx, job, channel);
    const setupMs = performance.now() - started;

    const outcome = await evaluate(ctx, job, control, session, stringify);
    const runMs = performance.now() - started - setupMs;
    report = {
      outcome: outcome.t === "result" ? { ...outcome, stats: { setupMs, runMs } } : outcome,
      recycle: false,
    };
  } catch (error) {
    // Raised by the host layer, not the guest: QuickJS reports guest errors as values.
    report =
      error instanceof RangeError && /call stack/i.test(error.message)
        ? { outcome: { t: "error", code: "code_error", message: "stack overflow" }, recycle: true }
        : internal(error instanceof Error ? error.message : String(error), true);
  }

  try {
    session?.dispose();
    for (const handle of held) handle.dispose();
    ctx.dispose();
    runtime.dispose();
  } catch {
    // A leaked handle or an aborted module: this runner's QuickJS can no longer be trusted.
    return { ...report, recycle: true };
  }
  return report;
}

type Settled = Omit<Extract<ExecOutcome, { t: "result" }>, "stats"> | ErrorFrame;

async function evaluate(
  ctx: QuickJSContext,
  job: ExecJob,
  control: RunControl,
  session: GuestSession,
  stringify: QuickJSHandle,
): Promise<Settled> {
  const evaluated = ctx.evalCode(`${PREFIX}${job.source}${SUFFIX}`, SOURCE_NAME, { type: "global" });
  if (evaluated.error) {
    const handle = evaluated.error;
    try {
      const described = describe(ctx, handle);
      if (described.name === "SyntaxError") {
        return { t: "error", code: "code_syntax_error", message: described.message, ...position(described) };
      }
      return classify(ctx, job, control, described);
    } finally {
      handle.dispose();
    }
  }

  const promise = evaluated.value;
  try {
    for (;;) {
      const state = ctx.getPromiseState(promise);
      if (state.type === "fulfilled") {
        // A non-promise value comes back as the same handle, owned by `promise`.
        const value = state.value;
        try {
          return serialise(ctx, job, control, session, stringify, value);
        } finally {
          if (!state.notAPromise) value.dispose();
        }
      }
      if (state.type === "rejected") {
        try {
          return classify(ctx, job, control, describe(ctx, state.error));
        } finally {
          state.error.dispose();
        }
      }

      if (Date.now() >= job.deadline || control.cancelled()) return classify(ctx, job, control, undefined);

      if (ctx.runtime.hasPendingJob()) {
        const ran = ctx.runtime.executePendingJobs(JOB_BATCH);
        if (ran.error) {
          const handle = ran.error;
          try {
            return classify(ctx, job, control, describe(ctx, handle));
          } finally {
            handle.dispose();
          }
        }
        continue;
      }

      if (session.inFlight() > 0) {
        await session.waitForHost();
        continue;
      }

      // Nothing queued in the guest and nothing outstanding on the host: the promise can never
      // settle. Fail now rather than hold the runner until the deadline.
      return {
        t: "error",
        code: "code_error",
        message: "the code awaits a promise that can never settle",
      };
    }
  } finally {
    promise.dispose();
  }
}

function serialise(
  ctx: QuickJSContext,
  job: ExecJob,
  control: RunControl,
  session: GuestSession,
  stringify: QuickJSHandle,
  value: QuickJSHandle,
): Settled {
  // Runs guest code (toJSON, getters, proxies) under the same deadline and memory limit.
  const text = ctx.callFunction(stringify, ctx.undefined, value);
  if (text.error) {
    const handle = text.error;
    try {
      const described = describe(ctx, handle);
      const outcome = classify(ctx, job, control, described);
      if (outcome.code !== "code_error") return outcome;
      return { ...outcome, message: `the return value cannot be turned into JSON: ${described.message}` };
    } finally {
      handle.dispose();
    }
  }
  const handle = text.value;
  try {
    const json = ctx.typeof(handle) === "string" ? ctx.getString(handle) : undefined;
    return {
      t: "result",
      value: json === undefined ? null : (JSON.parse(json) as unknown),
      scopePatches: session.scopePatches(),
    };
  } finally {
    handle.dispose();
  }
}

interface Described {
  /** The thrown value was `null` or `undefined`. */
  nullish: boolean;
  name: string | undefined;
  message: string;
  stack: string | undefined;
  lineNumber: number | undefined;
}

/** Reads an error value without trusting it: getters may throw, loop or allocate. */
function describe(ctx: QuickJSContext, handle: QuickJSHandle): Described {
  const kind = ctx.typeof(handle);
  if ((kind !== "object" && kind !== "function") || ctx.sameValue(handle, ctx.null)) {
    const text = primitiveText(ctx, handle);
    return {
      nullish: text === "null" || text === "undefined",
      name: undefined,
      message: text,
      stack: undefined,
      lineNumber: undefined,
    };
  }
  const name = readProp(ctx, handle, "name");
  const message = readProp(ctx, handle, "message");
  const lineNumber = readProp(ctx, handle, "lineNumber");
  return {
    nullish: false,
    name: asString(name),
    message: typeof message === "string" ? message : "an object was thrown",
    stack: asString(readProp(ctx, handle, "stack")),
    lineNumber: typeof lineNumber === "number" ? lineNumber : undefined,
  };
}

function readProp(ctx: QuickJSContext, handle: QuickJSHandle, key: string): string | number | undefined {
  let prop: QuickJSHandle | undefined;
  try {
    prop = ctx.getProp(handle, key);
    const kind = ctx.typeof(prop);
    if (kind === "string") return ctx.getString(prop);
    if (kind === "number") return ctx.getNumber(prop);
    return undefined;
  } catch {
    return undefined;
  } finally {
    prop?.dispose();
  }
}

function primitiveText(ctx: QuickJSContext, handle: QuickJSHandle): string {
  const kind = ctx.typeof(handle);
  if (kind === "object") return "null";
  if (kind === "string") return ctx.getString(handle);
  if (kind === "number") return String(ctx.getNumber(handle));
  if (kind === "bigint") return String(ctx.getBigInt(handle));
  if (kind === "undefined") return "undefined";
  if (kind === "boolean") return String(ctx.dump(handle));
  if (kind === "symbol") return "a symbol was thrown";
  return "a value was thrown";
}

const asString = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Maps a guest failure to an error frame. The deadline and the cancel flag decide timeouts, not the
 * error's text, because guest code can throw an `InternalError("interrupted")` of its own.
 */
function classify(
  ctx: QuickJSContext,
  job: ExecJob,
  control: RunControl,
  described: Described | undefined,
): ErrorFrame {
  if (Date.now() >= job.deadline || control.cancelled() || described === undefined) {
    return { t: "error", code: "code_timeout", message: `ran longer than ${job.timeoutMs} ms` };
  }
  const outOfMemory = described.name === "InternalError" && described.message === "out of memory";
  if (outOfMemory || (described.nullish && atMemoryLimit(ctx, job))) {
    return { t: "error", code: "code_memory_exceeded", message: `used more than ${job.memoryMb} MB` };
  }
  return { t: "error", code: "code_error", message: described.message, ...position(described) };
}

/**
 * When QuickJS runs out of memory while building its own "out of memory" error (a flood of promise
 * jobs does this), the exception arrives as `null`. A nullish exception from a heap at its limit is
 * therefore a memory failure. A program that holds as much data and then throws `null` itself is
 * reported the same way; nothing else can tell the two apart. Only called after the guest stopped:
 * the limit is lifted so the measurement itself can allocate.
 */
function atMemoryLimit(ctx: QuickJSContext, job: ExecJob): boolean {
  const limitBytes = job.memoryMb * 1024 * 1024;
  let usage: QuickJSHandle | undefined;
  try {
    ctx.runtime.setMemoryLimit(-1);
    usage = ctx.runtime.computeMemoryUsage();
    const used = readProp(ctx, usage, "memory_used_size");
    return typeof used === "number" && used >= limitBytes;
  } catch {
    return false;
  } finally {
    usage?.dispose();
    ctx.runtime.setMemoryLimit(limitBytes);
  }
}

/** Line and column of the innermost frame in the caller's code, mapped back through the prefix. */
function position(described: Described): { line?: number; column?: number } {
  const escaped = SOURCE_NAME.replace(".", "\\.");
  const match = described.stack?.match(new RegExp(`${escaped}:(\\d+)(?::(\\d+))?`));
  const line = match?.[1] !== undefined ? Number(match[1]) : described.lineNumber;
  if (line === undefined || line < 1) return {};
  let column = match?.[2] !== undefined ? Number(match[2]) : undefined;
  if (column !== undefined && line === 1) column -= PREFIX.length;
  return column !== undefined && column >= 1 ? { line, column } : { line };
}

function internal(message: string, recycle: boolean): RunReport {
  return { outcome: { t: "error", code: "internal_error", message }, recycle };
}
