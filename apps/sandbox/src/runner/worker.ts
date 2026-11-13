/**
 * A runner: one worker thread holding one QuickJS-WASM module and running one exec at a time, each
 * in a fresh runtime (architecture §5.1). Loaded by Node directly (type stripping), so it imports only
 * Node built-ins, QuickJS and relative `.ts` files.
 *
 * There is no fallback: if the module cannot load, the runner says so and the pool reports the
 * service unhealthy (ADR-003 decision 5).
 */
import { parentPort, workerData } from "node:worker_threads";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { type HostChannel, NO_GUEST_API } from "../guest/index.ts";
import type { MainToWorker, RunnerData, WorkerToMain } from "./messages.ts";
import { runExec } from "./run-exec.ts";

if (!parentPort) throw new Error("the runner must start as a worker thread");
const port = parentPort;

const data = workerData as RunnerData;
const cancel = new Int32Array(data.cancel);
const post = (message: WorkerToMain) => port.postMessage(message);

async function load(): Promise<QuickJSWASMModule | undefined> {
  try {
    const module = await newQuickJSWASMModuleFromVariant(variant);
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

const channelFor = (execId: string): HostChannel => ({
  send: (frame) => post({ type: "frame", execId, frame }),
  onFrame: (listener) => {
    const set = listeners.get(execId) ?? new Set();
    set.add(listener);
    listeners.set(execId, set);
    return () => set.delete(listener);
  },
});

function serve(quickjs: QuickJSWASMModule) {
  port.on("message", (message: MainToWorker) => {
    if (message.type === "host") {
      for (const listener of listeners.get(message.execId) ?? []) listener(message.frame);
      return;
    }
    void (async () => {
      const { job } = message;
      const report = await runExec(
        quickjs,
        job,
        { cancelled: () => Atomics.load(cancel, 0) !== 0 },
        NO_GUEST_API,
        channelFor(job.execId),
      );
      listeners.delete(job.execId);
      // Freed runtimes return memory to the module's allocator, but the WASM memory never shrinks.
      const grown = quickjs.getWasmMemory().buffer.byteLength > data.wasmMemoryMaxBytes;
      post({ type: "done", execId: job.execId, outcome: report.outcome, recycle: report.recycle || grown });
    })();
  });
  post({ type: "ready" });
}

// With no message listener after a failed load, the thread ends on its own once the report is sent.
const loaded = await load();
if (loaded) serve(loaded);
