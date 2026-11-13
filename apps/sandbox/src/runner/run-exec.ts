/**
 * One execution in a fresh QuickJS runtime (architecture §5.1, ADR-003). Runs inside a runner
 * thread; imports only QuickJS types and relative files.
 *
 * Every handle taken here is disposed before the runtime is freed: QuickJS asserts that its heap is
 * empty when a runtime is freed and aborts the whole WASM module otherwise. Any exception from the
 * QuickJS host layer itself therefore retires the runner (`recycle`) instead of reusing it.
 */
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";
import { type GuestSession, type HostChannel, installGuest, PreludeError } from "../guest/index.ts";
import type { ErrorFrame, ExecOutcome } from "../protocol.ts";
import { createHeapGuard, type HeapGuard } from "./heap.ts";
import type { ExecJob } from "./messages.ts";

/** File name the guest's stack traces and syntax errors refer to. */
export const SOURCE_NAME = "code.js";
/** File name of each expression in a batch. */
const EXPRESSION_NAME = "expression.js";

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
  /**
   * True when the module's WASM memory has grown to its fixed maximum. The runner is replaced after
   * any exec that leaves it there, so during an exec it means this exec filled the heap.
   */
  atCeiling(): boolean;
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
  channel: HostChannel,
): Promise<RunReport> {
  const started = performance.now();
  if (job.kind !== "code" && job.kind !== "expressions") {
    return internal(`kind ${job.kind} has no guest layer yet`, false);
  }

  const runtime = quickjs.newRuntime();
  const ctx = runtime.newContext();
  const held: QuickJSHandle[] = [];
  let session: GuestSession | undefined;
  let guard: HeapGuard | undefined;
  let report: RunReport;
  try {
    guard = createHeapGuard(ctx);
    if (job.reserveBytes > 0) {
      // Held by the host, reachable from no guest value: it takes the share of the module's fixed
      // WASM ceiling that this exec's lower limit does not grant. Taken before the limit is set.
      const reserve = guard.hold(job.reserveBytes);
      if (!reserve) return internal("the runner's memory is fragmented", true);
      held.push(reserve);
    }
    runtime.setMemoryLimit(job.memoryMb * 1024 * 1024);
    runtime.setMaxStackSize(job.stackBytes);
    runtime.setInterruptHandler(() => Date.now() >= job.deadline || control.cancelled());

    // Take the intrinsic JSON.stringify before any guest code can replace it.
    const json = ctx.getProp(ctx.global, "JSON");
    const stringify = ctx.getProp(json, "stringify");
    json.dispose();
    held.push(stringify);

    session = installGuest(ctx, job, channel, guard);
    const setupMs = performance.now() - started;

    const outcome =
      job.kind === "expressions"
        ? evaluateExpressions(ctx, job, control, stringify, guard)
        : await evaluate(ctx, job, control, session, stringify, guard);
    session.finish();
    const runMs = performance.now() - started - setupMs;
    report = {
      outcome:
        outcome.t === "result"
          ? { ...outcome, stats: { setupMs, runMs } }
          : { ...outcome, message: session.redact(outcome.message) },
      recycle: false,
    };
  } catch (error) {
    // Raised by the host layer, not the guest: QuickJS reports guest errors as values.
    if (error instanceof PreludeError) {
      // The guest API could not be installed: no guest code ran yet, so only the limits can be to blame.
      const outcome: ErrorFrame | undefined =
        error.reason === "memory"
          ? memoryExceeded(job)
          : error.reason === "nesting"
            ? { t: "error", code: "code_error", message: error.message }
            : limitFailure(ctx, job, control);
      report = { outcome: outcome ?? internal(error.message, false).outcome, recycle: false };
    } else {
      report =
        error instanceof RangeError && /call stack/i.test(error.message)
          ? { outcome: { t: "error", code: "code_error", message: "stack overflow" }, recycle: true }
          : internal(error instanceof Error ? error.message : String(error), true);
    }
  }

  try {
    session?.dispose();
    for (const handle of held) handle.dispose();
    guard?.dispose();
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
  guard: HeapGuard,
): Promise<Settled> {
  const wrapped = `${PREFIX}${job.source}${SUFFIX}`;
  // The scopes are in the heap by now; the source is copied in only if it fits (see heap.ts).
  if (!guard.room(Buffer.byteLength(wrapped, "utf8"))) return memoryExceeded(job);
  // Strict mode (ADR-023 §7): a write to a frozen scope throws at its line instead of being ignored.
  const evaluated = ctx.evalCode(wrapped, SOURCE_NAME, { type: "global", strict: true });
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
      // A host answer that did not fit in the heap could not be delivered (see heap.ts).
      if (session.outOfMemory()) return memoryExceeded(job);

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
        await session.waitForHost(job.deadline);
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

/** Scope patches from the prelude's snapshot (ADR-023 §2), or the error that stopped them. */
function patchesOf(
  ctx: QuickJSContext,
  job: ExecJob,
  control: RunControl,
  session: GuestSession,
): { ok: true; patches: Record<string, unknown> } | { ok: false; error: ErrorFrame } {
  if (!session.snapshot) return { ok: true, patches: {} };
  // Runs guest code (toJSON, getters) under the same deadline and memory limit.
  const taken = ctx.callFunction(session.snapshot, ctx.undefined);
  if (taken.error) {
    const handle = taken.error;
    try {
      return { ok: false, error: classify(ctx, job, control, describe(ctx, handle)) };
    } finally {
      handle.dispose();
    }
  }
  const handle = taken.value;
  try {
    const text = ctx.typeof(handle) === "string" ? ctx.getString(handle) : "";
    return { ok: true, patches: session.parsePatches(text) };
  } catch {
    // Only a guest that replaced the built-ins the snapshot relies on gets here.
    return { ok: false, error: { t: "error", code: "code_error", message: "the variables could not be saved" } };
  } finally {
    handle.dispose();
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
  const patches = patchesOf(ctx, job, control, session);
  if (!patches.ok) return patches.error;
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
      scopePatches: patches.patches,
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
  if (outOfMemory || (described.nullish && (control.atCeiling() || atMemoryLimit(ctx, job)))) {
    return { t: "error", code: "code_memory_exceeded", message: `used more than ${job.memoryMb} MB` };
  }
  return { t: "error", code: "code_error", message: described.message, ...position(described) };
}

/**
 * When QuickJS runs out of memory while building its own "out of memory" error (a flood of promise
 * jobs, or many small allocations up to the WASM ceiling, does this), the exception arrives as `null`.
 * A nullish exception from a heap at its limit, or from a module at its ceiling, is therefore a
 * memory failure. A program that holds as much data and then throws `null` itself is
 * reported the same way; nothing else can tell the two apart. Only called after the guest stopped:
 * the limit is lifted so the measurement itself can allocate.
 */
function atMemoryLimit(ctx: QuickJSContext, job: ExecJob, share = 1): boolean {
  const limitBytes = job.memoryMb * 1024 * 1024;
  let usage: QuickJSHandle | undefined;
  try {
    ctx.runtime.setMemoryLimit(-1);
    usage = ctx.runtime.computeMemoryUsage();
    const used = readProp(ctx, usage, "memory_used_size");
    return typeof used === "number" && used >= limitBytes * share;
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

/**
 * `kind: "expressions"` (ADR-018 §2–§3): each expression in its own evaluation, so a syntax error or
 * a throw affects only its own outcome. The pool parsed every source first and marked the ones that
 * are not a single expression, so the parentheses here cannot be closed early to run statements.
 * Only a deadline or memory failure ends the batch as a whole.
 */
function evaluateExpressions(
  ctx: QuickJSContext,
  job: ExecJob,
  control: RunControl,
  stringify: QuickJSHandle,
  guard: HeapGuard,
): Settled {
  const outcomes: ({ ok: true; value?: unknown } | { ok: false; message: string })[] = [];
  for (const expression of job.expressions ?? []) {
    if (expression.invalid !== undefined) {
      outcomes.push({ ok: false, message: expression.invalid });
      continue;
    }
    const text = `(${expression.source}\n)`;
    // An earlier expression may have filled the heap; the text is copied in only if it fits.
    if (!guard.room(Buffer.byteLength(text, "utf8"))) return memoryExceeded(job);
    const evaluated = ctx.evalCode(text, EXPRESSION_NAME, { type: "global", strict: true });
    if (evaluated.error) {
      const handle = evaluated.error;
      try {
        const failure = classify(ctx, job, control, describe(ctx, handle));
        if (failure.code !== "code_error") return failure;
        outcomes.push({ ok: false, message: failure.message });
      } finally {
        handle.dispose();
      }
      continue;
    }
    const value = evaluated.value;
    try {
      const text = ctx.callFunction(stringify, ctx.undefined, value);
      if (text.error) {
        const handle = text.error;
        try {
          const described = describe(ctx, handle);
          const failure = classify(ctx, job, control, described);
          if (failure.code !== "code_error") return failure;
          outcomes.push({ ok: false, message: `the value cannot be turned into JSON: ${described.message}` });
        } finally {
          handle.dispose();
        }
        continue;
      }
      const handle = text.value;
      try {
        if (ctx.typeof(handle) === "string") outcomes.push({ ok: true, value: JSON.parse(ctx.getString(handle)) });
        else outcomes.push({ ok: true });
      } finally {
        handle.dispose();
      }
    } finally {
      value.dispose();
    }
    if (Date.now() >= job.deadline || control.cancelled()) return classify(ctx, job, control, undefined);
  }
  return { t: "result", value: outcomes, scopePatches: {} };
}

/** A timeout or memory failure when that is what stopped the run, else undefined. */
function limitFailure(ctx: QuickJSContext, job: ExecJob, control: RunControl): ErrorFrame | undefined {
  if (Date.now() >= job.deadline || control.cancelled()) return classify(ctx, job, control, undefined);
  if (atMemoryLimit(ctx, job, 0.5)) {
    return { t: "error", code: "code_memory_exceeded", message: `used more than ${job.memoryMb} MB` };
  }
  return undefined;
}

function memoryExceeded(job: ExecJob): ErrorFrame {
  return { t: "error", code: "code_memory_exceeded", message: `used more than ${job.memoryMb} MB` };
}

function internal(message: string, recycle: boolean): RunReport {
  return { outcome: { t: "error", code: "internal_error", message }, recycle };
}
