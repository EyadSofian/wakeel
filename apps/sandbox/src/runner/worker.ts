/**
 * A runner: one worker thread holding one QuickJS-WASM module and running one exec at a time, each
 * in a fresh runtime (architecture §5.1). Loaded by Node directly (type stripping), so it imports only
 * Node built-ins, QuickJS and relative `.ts` files.
 *
 * There is no fallback: if the module cannot load, the runner says so and the pool reports the
 * service unhealthy (ADR-003 decision 5).
 *
 * The module gets a WASM memory with a fixed maximum. That ceiling, not QuickJS's memory limit, is
 * what bounds the heap: QuickJS built for WASM cannot measure its allocations (see
 * docs/security/sandbox-review.md §2).
 */
import { parentPort, workerData } from "node:worker_threads";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import type { CallAnswer, HostChannel } from "../guest/index.ts";
import type { MainToWorker, RunnerData, WorkerToMain } from "./messages.ts";
import { runExec } from "./run-exec.ts";

if (!parentPort) throw new Error("the runner must start as a worker thread");
const port = parentPort;

const data = workerData as RunnerData;
/** A global in Node; the ES2023 lib types `WebAssembly` as a namespace without its constructors. */
const WasmMemory = (
  globalThis as unknown as {
    WebAssembly: {
      Memory: new (descriptor: { initial: number; maximum: number }) => ReturnType<QuickJSWASMModule["getWasmMemory"]>;
    };
  }
).WebAssembly.Memory;
const cancel = new Int32Array(data.cancel);
/** WebAssembly page size. */
const PAGE = 64 * 1024;
const post = (message: WorkerToMain) => port.postMessage(message);

async function load(): Promise<QuickJSWASMModule | undefined> {
  try {
    const memory = new WasmMemory({
      initial: Math.ceil(data.wasmMemory.initialBytes / PAGE),
      maximum: Math.floor(data.wasmMemory.maximumBytes / PAGE),
    });
    const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }));
    if (module.getWasmMemory() !== memory) throw new Error("QuickJS did not take the capped WASM memory");
    // Prove the interpreter runs before taking work.
    const probe = module.evalCode("6 * 7");
    if (probe !== 42) throw new Error(`the QuickJS self-test returned ${String(probe)}`);
    return module;
  } catch (error) {
    post({ type: "load_failed", message: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

const listeners = new Map<string, Set<(frame: unknown) => void>>();
const fetches = new Map<number, (answer: CallAnswer) => void>();
let nextFetch = 0;

const channelFor = (execId: string): HostChannel => ({
  send: (frame) => post({ type: "frame", execId, frame }),
  onFrame: (listener) => {
    const set = listeners.get(execId) ?? new Set();
    set.add(listener);
    listeners.set(execId, set);
    return () => set.delete(listener);
  },
  fetch: (request) =>
    new Promise<CallAnswer>((resolve) => {
      const fetchId = nextFetch++;
      fetches.set(fetchId, resolve);
      post({ type: "fetch", execId, fetchId, request });
    }),
});

function serve(quickjs: QuickJSWASMModule) {
  const ceiling = Math.floor(data.wasmMemory.maximumBytes / PAGE) * PAGE;
  // Emscripten grows the memory by at least 5% at a time and gives up when that passes the maximum,
  // so a full heap leaves the memory up to 5% short of the ceiling, never at it.
  const atCeiling = () => quickjs.getWasmMemory().buffer.byteLength * 1.05 >= ceiling;
  port.on("message", (message: MainToWorker) => {
    if (message.type === "host") {
      for (const listener of listeners.get(message.execId) ?? []) listener(message.frame);
      return;
    }
    if (message.type === "fetch_result") {
      const resolve = fetches.get(message.fetchId);
      fetches.delete(message.fetchId);
      resolve?.(message.answer);
      return;
    }
    void (async () => {
      const { job } = message;
      const report = await runExec(
        quickjs,
        job,
        { cancelled: () => Atomics.load(cancel, 0) !== 0, atCeiling },
        channelFor(job.execId),
      );
      listeners.delete(job.execId);
      // A fetch still out when the exec ended is answered into nothing; the pool aborts it.
      fetches.clear();
      // The WASM memory never shrinks. A runner whose exec reached the ceiling is replaced, so
      // `atCeiling` stays a signal about the running exec and the next one starts with room.
      post({ type: "done", execId: job.execId, outcome: report.outcome, recycle: report.recycle || atCeiling() });
    })();
  });
  post({ type: "ready" });
}

// With no message listener after a failed load, the thread ends on its own once the report is sent.
const loaded = await load();
if (loaded) serve(loaded);
