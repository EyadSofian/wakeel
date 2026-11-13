/**
 * The runner pool (architecture §5.1, §15; ADR-003). Each runner is a worker thread with its own
 * QuickJS-WASM module and runs one exec at a time, so a hard kill never takes another tenant's exec
 * with it. Two layers stop runaway code:
 *
 * 1. the interpreter's interrupt handler, which fires at the deadline or when the cancel flag is set;
 * 2. `worker.terminate()` once the runner is still busy `killGraceMs` after that, for stalls the
 *    interrupt cannot reach. A killed or retired runner is replaced with a fresh one.
 */
import { Worker } from "node:worker_threads";
import { SANDBOX_LIMITS } from "@wakeel/config";
import { AppError } from "@wakeel/contracts";
import type { ExecOutcome } from "./protocol.ts";
import type { ExecJob, ExecJobInput, MainToWorker, RunnerData, WorkerToMain } from "./runner/messages.ts";

export type { ExecOutcome } from "./protocol.ts";

const RUNNER_URL = new URL("./runner/worker.ts", import.meta.url);

export interface PoolOptions {
  /** Runners kept alive; architecture §15 sizes it at CPU cores × 2. */
  size: number;
  /** Execs that may wait for a runner. Defaults to `size × SANDBOX_LIMITS.queuePerRunner`. */
  queueLimit?: number;
  /** Tests substitute stand-in runners. */
  workerUrl?: URL;
  /** Called on every hard kill, for metrics and logs. Never receives source or scopes. */
  onKill?: (info: { execId: string; reason: "deadline" | "cancelled" }) => void;
}

export interface ExecOptions {
  /** Aborting cancels the exec; the returned promise rejects with the abort reason. */
  signal?: AbortSignal;
  /** Frames the guest layer sends while the exec runs (tool calls, logs; task 3.3). */
  onFrame?: (frame: unknown) => void;
}

export interface PoolHealth {
  ready: boolean;
  size: number;
  /** Runners that loaded QuickJS and are alive, busy or idle. */
  live: number;
  busy: number;
  queued: number;
  /** Hard kills since start. */
  kills: number;
  /** Why QuickJS could not load, when it could not. */
  loadError?: string;
}

interface Task {
  job: ExecJobInput;
  options: ExecOptions;
  resolve: (outcome: ExecOutcome) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  onAbort?: () => void;
}

interface Runner {
  worker: Worker;
  state: "starting" | "idle" | "busy" | "gone";
  cancel: Int32Array;
  task?: Task;
  killTimer?: NodeJS.Timeout;
}

export class SandboxPool {
  readonly #size: number;
  readonly #queueLimit: number;
  readonly #workerUrl: URL;
  readonly #onKill: PoolOptions["onKill"];
  readonly #runners = new Set<Runner>();
  readonly #queue: Task[] = [];
  readonly #starting = new Map<Runner, { resolve: () => void; reject: (e: Error) => void }>();
  #kills = 0;
  #loadError: string | undefined;
  #closed = false;
  #readyWaiters: (() => void)[] = [];

  constructor(options: PoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) throw new Error("the pool needs at least one runner");
    this.#size = options.size;
    this.#queueLimit = options.queueLimit ?? options.size * SANDBOX_LIMITS.queuePerRunner;
    this.#workerUrl = options.workerUrl ?? RUNNER_URL;
    this.#onKill = options.onKill;
  }

  /** Starts every runner. Rejects if QuickJS cannot load; the pool then stays unhealthy. */
  async start(): Promise<void> {
    await Promise.all(Array.from({ length: this.#size }, () => this.#spawn()));
  }

  /** Resolves once no runner is starting (after a kill, its replacement is up). */
  whenReady(): Promise<void> {
    if (this.#starting.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#readyWaiters.push(resolve));
  }

  health(): PoolHealth {
    let live = 0;
    let busy = 0;
    for (const runner of this.#runners) {
      if (runner.state === "idle" || runner.state === "busy") live++;
      if (runner.state === "busy") busy++;
    }
    const health: PoolHealth = {
      ready: !this.#closed && this.#loadError === undefined && live > 0,
      size: this.#size,
      live,
      busy,
      queued: this.#queue.length,
      kills: this.#kills,
    };
    if (this.#loadError !== undefined) health.loadError = this.#loadError;
    return health;
  }

  /**
   * Runs one exec. Resolves with its result or error frame; rejects with an `AppError` when the pool
   * cannot take it (`validation_failed`, `rate_limited`, `internal_error`) or with the abort reason.
   */
  exec(job: ExecJobInput, options: ExecOptions = {}): Promise<ExecOutcome> {
    if (job.kind !== "code") {
      // `expressions` (3.5, ADR-018) and `autonomy_run` (Phase 6) need their guest layers first.
      return Promise.reject(
        new AppError(
          "validation_failed",
          {},
          { errors: [{ path: "kind", code: "not_supported", message: `kind ${job.kind} is not supported yet` }] },
        ),
      );
    }
    if (this.#closed || this.#loadError !== undefined || this.#runners.size === 0) {
      return Promise.reject(new AppError("internal_error", {}, { detail: "the sandbox has no working runner" }));
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);

    return new Promise<ExecOutcome>((resolve, reject) => {
      const task: Task = { job, options, resolve, reject, settled: false };
      const idle = this.#idleRunner();
      if (idle) {
        this.#dispatch(idle, task);
        return;
      }
      if (this.#queue.length >= this.#queueLimit) {
        reject(new AppError("rate_limited", { retryAfter: 1 }, { detail: "every sandbox runner is busy" }));
        return;
      }
      this.#queue.push(task);
      if (options.signal) {
        task.onAbort = () => {
          const at = this.#queue.indexOf(task);
          if (at >= 0) this.#queue.splice(at, 1);
          this.#settle(task, { reason: options.signal?.reason });
        };
        options.signal.addEventListener("abort", task.onAbort, { once: true });
      }
    });
  }

  /** Hands a caller frame (a tool result) to the runner running `execId`. False if none is. */
  deliver(execId: string, frame: unknown): boolean {
    for (const runner of this.#runners) {
      if (runner.state === "busy" && runner.task?.job.execId === execId && !runner.task.settled) {
        runner.worker.postMessage({ type: "host", execId, frame } satisfies MainToWorker);
        return true;
      }
    }
    return false;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const task of this.#queue.splice(0)) {
      this.#settle(task, { reason: new AppError("internal_error", {}, { detail: "the sandbox is shutting down" }) });
    }
    const exits: Promise<number>[] = [];
    for (const runner of this.#runners) {
      clearTimeout(runner.killTimer);
      if (runner.task) {
        this.#settle(runner.task, {
          reason: new AppError("internal_error", {}, { detail: "the sandbox is shutting down" }),
        });
      }
      runner.state = "gone";
      exits.push(runner.worker.terminate());
    }
    this.#runners.clear();
    await Promise.allSettled(exits);
    this.#flushReadyWaiters();
  }

  #spawn(): Promise<void> {
    const cancel = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const data: RunnerData = { cancel, wasmMemoryMaxBytes: SANDBOX_LIMITS.threadWasmMemoryMb * 1024 * 1024 };
    const worker = new Worker(this.#workerUrl, {
      workerData: data,
      resourceLimits: {
        stackSizeMb: SANDBOX_LIMITS.threadStackMb,
        maxOldGenerationSizeMb: SANDBOX_LIMITS.threadHeapMb,
      },
      // The runner needs no environment: it holds no configuration and no credentials.
      env: {},
    });
    const runner: Runner = { worker, state: "starting", cancel: new Int32Array(cancel) };
    this.#runners.add(runner);

    const started = new Promise<void>((resolve, reject) => this.#starting.set(runner, { resolve, reject }));
    worker.on("message", (message: WorkerToMain) => this.#onMessage(runner, message));
    worker.on("error", (error) => this.#onGone(runner, error.message));
    worker.on("exit", (code) => this.#onGone(runner, `the runner exited with code ${code}`));
    return started;
  }

  #onMessage(runner: Runner, message: WorkerToMain): void {
    if (runner.state === "gone") return;
    switch (message.type) {
      case "ready": {
        runner.state = "idle";
        this.#started(runner);
        this.#pump();
        return;
      }
      case "load_failed": {
        this.#loadError = message.message;
        this.#retire(runner);
        this.#started(runner, new Error(`QuickJS could not load: ${message.message}`));
        this.#failQueue();
        return;
      }
      case "frame": {
        const task = runner.task;
        if (task && !task.settled && task.job.execId === message.execId) task.options.onFrame?.(message.frame);
        return;
      }
      case "done": {
        clearTimeout(runner.killTimer);
        const task = runner.task;
        runner.task = undefined;
        if (task) this.#settle(task, { outcome: message.outcome });
        if (message.recycle) {
          this.#replace(runner);
          return;
        }
        runner.state = "idle";
        this.#pump();
        return;
      }
    }
  }

  #onGone(runner: Runner, why: string): void {
    if (runner.state === "gone") return;
    const wasStarting = runner.state === "starting";
    clearTimeout(runner.killTimer);
    const task = runner.task;
    runner.task = undefined;
    if (task) this.#settle(task, { outcome: { t: "error", code: "internal_error", message: why } });
    if (wasStarting) {
      this.#loadError ??= why;
      this.#retire(runner);
      this.#started(runner, new Error(`QuickJS could not load: ${why}`));
      this.#failQueue();
      return;
    }
    this.#replace(runner);
  }

  #dispatch(runner: Runner, task: Task): void {
    runner.state = "busy";
    runner.task = task;
    Atomics.store(runner.cancel, 0, 0);
    const deadline = Date.now() + task.job.timeoutMs;
    const job: ExecJob = { ...task.job, deadline, stackBytes: SANDBOX_LIMITS.interpreterStackBytes };
    runner.worker.postMessage({ type: "exec", job } satisfies MainToWorker);

    runner.killTimer = setTimeout(
      () => this.#kill(runner, "deadline"),
      task.job.timeoutMs + SANDBOX_LIMITS.killGraceMs,
    );

    const signal = task.options.signal;
    if (signal) {
      task.onAbort = () => {
        // Ask the interpreter to stop now; terminate the thread if it has not within the grace period.
        Atomics.store(runner.cancel, 0, 1);
        clearTimeout(runner.killTimer);
        runner.killTimer = setTimeout(() => this.#kill(runner, "cancelled"), SANDBOX_LIMITS.killGraceMs);
        this.#settle(task, { reason: signal.reason });
      };
      signal.addEventListener("abort", task.onAbort, { once: true });
    }
  }

  #kill(runner: Runner, reason: "deadline" | "cancelled"): void {
    if (runner.state !== "busy") return;
    const task = runner.task;
    runner.task = undefined;
    this.#kills++;
    if (task) {
      this.#onKill?.({ execId: task.job.execId, reason });
      this.#settle(task, {
        outcome: { t: "error", code: "code_timeout", message: `ran longer than ${task.job.timeoutMs} ms` },
      });
    }
    this.#replace(runner);
  }

  /** Retires a runner and starts a fresh one in its place. */
  #replace(runner: Runner): void {
    this.#retire(runner);
    if (this.#closed || this.#loadError !== undefined) return;
    this.#spawn().catch(() => {
      // Recorded in #loadError and visible in health(); queued execs were failed there.
    });
  }

  #retire(runner: Runner): void {
    runner.state = "gone";
    clearTimeout(runner.killTimer);
    this.#runners.delete(runner);
    void runner.worker.terminate();
  }

  #started(runner: Runner, error?: Error): void {
    const waiter = this.#starting.get(runner);
    this.#starting.delete(runner);
    if (waiter) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    if (this.#starting.size === 0) this.#flushReadyWaiters();
  }

  #flushReadyWaiters(): void {
    for (const resolve of this.#readyWaiters.splice(0)) resolve();
  }

  #failQueue(): void {
    for (const task of this.#queue.splice(0)) {
      this.#settle(task, { reason: new AppError("internal_error", {}, { detail: "QuickJS could not load" }) });
    }
  }

  #idleRunner(): Runner | undefined {
    for (const runner of this.#runners) if (runner.state === "idle") return runner;
    return undefined;
  }

  #pump(): void {
    for (;;) {
      const runner = this.#idleRunner();
      const task = runner ? this.#queue.shift() : undefined;
      if (!runner || !task) return;
      if (task.onAbort) task.options.signal?.removeEventListener("abort", task.onAbort);
      task.onAbort = undefined;
      this.#dispatch(runner, task);
    }
  }

  #settle(task: Task, how: { outcome: ExecOutcome } | { reason: unknown }): void {
    if (task.settled) return;
    task.settled = true;
    if (task.onAbort) task.options.signal?.removeEventListener("abort", task.onAbort);
    if ("outcome" in how) task.resolve(how.outcome);
    else task.reject(how.reason);
  }
}
