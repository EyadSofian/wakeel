/**
 * The host side of the guest API (architecture §5.2, ADR-022, ADR-023). It installs the prelude
 * into a fresh context, answers the bridge, keeps the per-exec limits, redacts secrets from log
 * lines and error messages, and turns the prelude's snapshot into `scopePatches`.
 *
 * Runs inside the runner thread, so it imports only QuickJS types, Node built-ins and relative files.
 */
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from "quickjs-emscripten-core";
import type { ExecJob } from "../runner/messages.ts";
import { PRELUDE, PRELUDE_NAME } from "./prelude.ts";

/** Answer to a host call: what the prelude's `invoke` reads. */
export type CallAnswer = { ok: true; value: unknown } | { ok: false; code: string; message: string };

/** A guest `fetch`, as the prelude sends it. */
export interface GuestFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** How the guest layer talks to the caller and to egress, through the pool. */
export interface HostChannel {
  /** Sends a `tool_call` or `log` frame to the caller. */
  send(frame: unknown): void;
  /** Receives the caller's frames for this exec (tool results). Returns an unsubscribe function. */
  onFrame(listener: (frame: unknown) => void): () => void;
  /** Runs a guest `fetch` through egress on the pool's thread (ADR-023 §4). Never rejects. */
  fetch(request: GuestFetchRequest): Promise<CallAnswer>;
}

/** Per-exec limits (ADR-023 §3, §4, §6). */
export const GUEST_LIMITS = {
  toolCallsInFlight: 16,
  fetchesInFlight: 4,
  callsPerExec: 500,
  logLines: 200,
  logLineBytes: 8 * 1024,
  /** A call's input must fit in one frame with room for the envelope. */
  callInputBytes: 4 * 1024 * 1024 - 1024,
  /** Secrets shorter than this are not redacted (ADR-023 §6). */
  minSecretLength: 4,
} as const;

export const REDACTED = "[redacted]";

/** Platform calls that travel as `tool_call` frames (ADR-023 §3). Builder tools are not among them. */
const TOOL_OPS = new Set([
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
const LOG_LEVELS = new Set(["info", "warn", "error"]);
const PATCH_SCOPES = new Set(["workflow", "conversation", "user", "turn"]);
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface GuestSession {
  /** Host operations the guest is waiting for; while above zero, a pending promise is not a hang. */
  inFlight(): number;
  /** Resolves once a host operation has settled a guest promise, at `until` (epoch ms), or within 50 ms. */
  waitForHost(until: number): Promise<void>;
  /** The prelude's snapshot function for `code`; absent for `expressions`. */
  readonly snapshot: QuickJSHandle | undefined;
  /** Validates the prelude's patch text. Throws on anything but the ADR-023 §2 shape. */
  parsePatches(text: string): Record<string, unknown>;
  /** Replaces every secret value in `text`. */
  redact(text: string): string;
  /** Sends the "lines were dropped" notice, if any were. */
  finish(): void;
  /** Releases every handle the session holds; called before the context is disposed. */
  dispose(): void;
}

/** A failure of the prelude itself: our code, not the guest's, so the runner reports it as such. */
export class PreludeError extends Error {}

/**
 * Installs the guest API for `job` into `ctx`. The context must be fresh: nothing of the guest's has
 * run in it yet.
 */
export function installGuest(ctx: QuickJSContext, job: ExecJob, channel: HostChannel): GuestSession {
  const secrets = secretValues(job);
  const redact = (text: string) => redactText(text, secrets);
  const pending = new Map<number, QuickJSDeferredPromise>();
  const toolWaiting: (() => void)[] = [];
  const fetchWaiting: (() => void)[] = [];
  let toolsRunning = 0;
  let fetchesRunning = 0;
  let calls = 0;
  let nextId = 0;
  let logLines = 0;
  let dropped = 0;
  let wake: (() => void) | undefined;
  /** A settle that happened while nobody was waiting; the next wait returns at once. */
  let woken = false;
  let disposed = false;
  const owned: QuickJSHandle[] = [];

  const unsubscribe = channel.onFrame((frame) => onToolResult(frame));
  const toolAnswers = new Map<string, (answer: CallAnswer) => void>();

  function settle(id: number, answer: CallAnswer): void {
    const deferred = pending.get(id);
    pending.delete(id);
    if (!deferred || disposed) return;
    let text: string;
    try {
      text = JSON.stringify(answer);
    } catch {
      text = JSON.stringify({ ok: false, code: "internal_error", message: "the answer could not be read" });
    }
    try {
      const handle = ctx.newString(text);
      try {
        deferred.resolve(handle);
      } finally {
        handle.dispose();
      }
    } catch {
      // The heap is full or the deadline passed while resolving; the run loop reports which.
    } finally {
      deferred.dispose();
    }
    const w = wake;
    wake = undefined;
    if (w) w();
    else woken = true;
  }

  function onToolResult(frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as { t?: unknown; callId?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    if (f.t !== "tool_result" || typeof f.callId !== "string") return;
    const answer = toolAnswers.get(f.callId);
    if (!answer) return;
    toolAnswers.delete(f.callId);
    if (f.ok === true) {
      answer({ ok: true, value: f.value ?? null });
      return;
    }
    const e = (typeof f.error === "object" && f.error !== null ? f.error : {}) as { code?: unknown; message?: unknown };
    answer({
      ok: false,
      code: typeof e.code === "string" && CODE_PATTERN.test(e.code) ? e.code : "tool_failed",
      message: typeof e.message === "string" ? e.message : "the call failed",
    });
  }

  /** Waits for a free slot: tool calls and fetches each have their own limit. */
  function slot(kind: "tool" | "fetch"): Promise<void> {
    const running = kind === "tool" ? toolsRunning : fetchesRunning;
    const limit = kind === "tool" ? GUEST_LIMITS.toolCallsInFlight : GUEST_LIMITS.fetchesInFlight;
    if (running < limit) {
      if (kind === "tool") toolsRunning++;
      else fetchesRunning++;
      return Promise.resolve();
    }
    return new Promise((resolve) => (kind === "tool" ? toolWaiting : fetchWaiting).push(resolve));
  }

  function release(kind: "tool" | "fetch"): void {
    const queue = kind === "tool" ? toolWaiting : fetchWaiting;
    const next = queue.shift();
    if (next) {
      next();
      return;
    }
    if (kind === "tool") toolsRunning--;
    else fetchesRunning--;
  }

  async function perform(id: number, op: string, inputText: string): Promise<CallAnswer> {
    if (Buffer.byteLength(inputText, "utf8") > GUEST_LIMITS.callInputBytes) {
      return { ok: false, code: "code_error", message: `the input of ${op} is larger than 4 MB` };
    }
    let input: unknown;
    try {
      input = JSON.parse(inputText);
    } catch {
      return { ok: false, code: "code_error", message: `the input of ${op} is not JSON` };
    }
    if (op === "fetch") {
      await slot("fetch");
      try {
        return await channel.fetch(input as GuestFetchRequest);
      } finally {
        release("fetch");
      }
    }
    await slot("tool");
    try {
      const callId = `call_${id}`;
      const answered = new Promise<CallAnswer>((resolve) => toolAnswers.set(callId, resolve));
      channel.send({ t: "tool_call", callId, name: op, input });
      return await answered;
    } finally {
      release("tool");
    }
  }

  const callFn = ctx.newFunction("call", (opHandle, inputHandle) => {
    const op = ctx.typeof(opHandle) === "string" ? ctx.getString(opHandle) : "";
    const inputText = ctx.typeof(inputHandle) === "string" ? ctx.getString(inputHandle) : "null";
    const deferred = ctx.newPromise();
    const id = nextId++;
    pending.set(id, deferred);
    const promise = deferred.handle.dup();
    if (op !== "fetch" && !TOOL_OPS.has(op)) {
      queueMicrotask(() => settle(id, { ok: false, code: "code_error", message: `${op} is not a guest call` }));
    } else if (calls >= GUEST_LIMITS.callsPerExec) {
      queueMicrotask(() =>
        settle(id, {
          ok: false,
          code: "code_error",
          message: `more than ${GUEST_LIMITS.callsPerExec} calls in one run`,
        }),
      );
    } else {
      calls++;
      void perform(id, op, inputText).then(
        (answer) => settle(id, answer),
        () => settle(id, { ok: false, code: "internal_error", message: "the call failed" }),
      );
    }
    return promise;
  });
  owned.push(callFn);

  const emitFn = ctx.newFunction("emit", (levelHandle, argsHandle) => {
    const level = ctx.typeof(levelHandle) === "string" ? ctx.getString(levelHandle) : "";
    if (!LOG_LEVELS.has(level)) return;
    if (logLines >= GUEST_LIMITS.logLines) {
      dropped++;
      return;
    }
    logLines++;
    let args: unknown[] = [];
    try {
      const parsed: unknown = JSON.parse(ctx.typeof(argsHandle) === "string" ? ctx.getString(argsHandle) : "[]");
      if (Array.isArray(parsed)) args = parsed;
    } catch {
      args = ["a log line that could not be read"];
    }
    channel.send({ t: "log", level, args: cutArgs(redactValue(args, redact) as unknown[]) });
  });
  owned.push(emitFn);

  const config = JSON.stringify({
    kind: job.kind,
    scopes: job.scopes ?? {},
    tables: job.tables ?? [],
    idempotencyKey: job.idempotencyKey ?? job.execId,
  });

  const installed = ctx.evalCode(PRELUDE, PRELUDE_NAME, { type: "global", strict: true });
  if (installed.error) {
    installed.error.dispose();
    throw new PreludeError("the guest prelude did not compile");
  }
  const install = installed.value;
  let snapshot: QuickJSHandle | undefined;
  try {
    const configHandle = ctx.newString(config);
    try {
      const result = ctx.callFunction(install, ctx.undefined, callFn, emitFn, configHandle);
      if (result.error) {
        result.error.dispose();
        throw new PreludeError("the guest prelude failed to install");
      }
      if (ctx.typeof(result.value) === "function") {
        snapshot = result.value;
        owned.push(snapshot);
      } else {
        result.value.dispose();
      }
    } finally {
      configHandle.dispose();
    }
  } finally {
    install.dispose();
  }

  return {
    inFlight: () => pending.size,
    waitForHost: (until) =>
      new Promise<void>((resolve) => {
        if (woken) {
          woken = false;
          resolve();
          return;
        }
        // Wakes at least every 50 ms so the run loop sees a cancel without waiting for the deadline.
        const timer = setTimeout(
          () => {
            wake = undefined;
            resolve();
          },
          Math.max(0, Math.min(until - Date.now(), 50)),
        );
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      }),
    snapshot,
    parsePatches,
    redact,
    finish: () => {
      if (dropped > 0) {
        const message = dropped === 1 ? "1 log line was dropped" : `${dropped} log lines were dropped`;
        channel.send({ t: "log", level: "warn", args: [message] });
      }
    },
    dispose: () => {
      disposed = true;
      unsubscribe();
      toolAnswers.clear();
      for (const deferred of pending.values()) deferred.dispose();
      pending.clear();
      for (const handle of owned) handle.dispose();
      owned.length = 0;
    },
  };
}

/** The ADR-023 §2 shape, checked on the host: the prelude ran in the guest's heap. */
function parsePatches(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("patches: not an object");
  const out: Record<string, unknown> = {};
  for (const [scope, patch] of Object.entries(parsed)) {
    if (!PATCH_SCOPES.has(scope)) throw new Error(`patches: ${scope} cannot be written`);
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("patches: bad patch");
    const { set, unset, ...rest } = patch as { set?: unknown; unset?: unknown };
    if (Object.keys(rest).length > 0) throw new Error("patches: unknown key");
    const clean: { set?: Record<string, unknown>; unset?: string[] } = {};
    if (set !== undefined) {
      if (typeof set !== "object" || set === null || Array.isArray(set)) throw new Error("patches: bad set");
      if (scope === "user" && Object.hasOwn(set, "attributes"))
        throw new Error("patches: user.attributes is read-only");
      clean.set = set as Record<string, unknown>;
    }
    if (unset !== undefined) {
      if (!Array.isArray(unset) || !unset.every((n) => typeof n === "string")) throw new Error("patches: bad unset");
      if (scope === "user" && unset.includes("attributes")) throw new Error("patches: user.attributes is read-only");
      clean.unset = unset as string[];
    }
    out[scope] = clean;
  }
  return out;
}

/** Secret values of this exec, longest first, with their JSON-escaped forms (ADR-023 §6). */
function secretValues(job: ExecJob): string[] {
  const env = job.scopes?.["env"];
  if (typeof env !== "object" || env === null) return [];
  const values = new Set<string>();
  for (const key of job.secretKeys ?? []) {
    const value = (env as Record<string, unknown>)[key];
    if (typeof value !== "string" || value.length < GUEST_LIMITS.minSecretLength) continue;
    values.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) values.add(escaped);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out;
}

function redactValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactValue(v, redact);
    return out;
  }
  return value;
}

/** Keeps a log line under `logLineBytes`: arguments past the budget become cut text (ADR-023 §6). */
function cutArgs(args: unknown[]): unknown[] {
  const limit = GUEST_LIMITS.logLineBytes;
  if (Buffer.byteLength(JSON.stringify(args), "utf8") <= limit) return args;
  const out: unknown[] = [];
  let budget = limit - 16;
  for (const arg of args) {
    const size = Buffer.byteLength(JSON.stringify(arg), "utf8");
    if (size <= budget) {
      out.push(arg);
      budget -= size + 1;
      continue;
    }
    const text = typeof arg === "string" ? arg : JSON.stringify(arg);
    out.push(`${cutToBytes(text, Math.max(0, budget - 8))}…`);
    break;
  }
  return out;
}

/** The longest prefix of `text` whose JSON form fits in `bytes`, never splitting a character. */
function cutToBytes(text: string, bytes: number): string {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(JSON.stringify(ch).slice(1, -1), "utf8");
    if (used + size > bytes) break;
    used += size;
    end += ch.length;
  }
  return text.slice(0, end);
}
