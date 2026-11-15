/**
 * A runner that never honours its deadline or cancel flag, standing in for a stall the QuickJS
 * interrupt cannot reach (a long native call). Only the pool's hard kill can stop it.
 */
import { parentPort } from "node:worker_threads";
import type { MainToWorker, WorkerToMain } from "../../src/runner/messages.ts";

const post = (message: WorkerToMain) => parentPort?.postMessage(message);

parentPort?.on("message", (message: MainToWorker) => {
  if (message.type !== "exec") return;
  for (;;) {
    // Spin on the host thread itself; nothing but worker.terminate() ends this.
  }
});
post({ type: "ready" });
