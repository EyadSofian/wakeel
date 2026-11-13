import { SANDBOX_LIMITS } from "@wakeel/config";
import { describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";

/** The hard kill and the unhealthy state, driven by stand-in runners from test/fixtures. */

const stuck = new URL("./fixtures/stuck-worker.ts", import.meta.url);
const broken = new URL("./fixtures/broken-worker.ts", import.meta.url);

const job = { execId: "exec_kill", kind: "code" as const, source: "for (;;) {}", timeoutMs: 100, memoryMb: 16 };

describe("hard kill", () => {
  test("a runner that ignores the deadline is terminated 250 ms after it and replaced", async () => {
    const pool = new SandboxPool({ size: 1, workerUrl: stuck });
    await pool.start();
    try {
      const started = Date.now();
      const outcome = await pool.exec(job);
      const elapsed = Date.now() - started;
      expect(outcome).toMatchObject({ t: "error", code: "code_timeout" });
      expect(elapsed).toBeGreaterThanOrEqual(job.timeoutMs + SANDBOX_LIMITS.killGraceMs);
      expect(elapsed).toBeLessThan(job.timeoutMs + SANDBOX_LIMITS.killGraceMs + 1_000);
      expect(pool.health().kills).toBe(1);
      await pool.whenReady();
      expect(pool.health()).toMatchObject({ ready: true, live: 1 });
    } finally {
      await pool.close();
    }
  });

  test("an aborted exec in a runner that ignores the cancel flag is terminated after the grace period", async () => {
    const pool = new SandboxPool({ size: 1, workerUrl: stuck });
    await pool.start();
    try {
      const controller = new AbortController();
      const pending = pool.exec({ ...job, timeoutMs: 10_000 }, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow();
      await pool.whenReady();
      expect(pool.health().kills).toBe(1);
    } finally {
      await pool.close();
    }
  });
});

describe("unhealthy", () => {
  test("if QuickJS cannot load, start fails and the pool is not ready; there is no fallback", async () => {
    const pool = new SandboxPool({ size: 1, workerUrl: broken });
    await expect(pool.start()).rejects.toThrow(/could not be compiled/);
    expect(pool.health()).toMatchObject({ ready: false, live: 0 });
    await expect(pool.exec(job)).rejects.toMatchObject({ code: "internal_error" });
    await pool.close();
  });
});
