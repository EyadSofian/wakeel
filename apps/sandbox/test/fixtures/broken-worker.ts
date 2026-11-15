/** A runner whose QuickJS module cannot load: the pool must report itself unhealthy. */
import { parentPort } from "node:worker_threads";
import type { WorkerToMain } from "../../src/runner/messages.ts";

const message: WorkerToMain = { type: "load_failed", message: "WebAssembly module could not be compiled" };
parentPort?.postMessage(message);
