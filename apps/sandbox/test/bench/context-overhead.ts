/**
 * Measures what a fresh runtime and context per exec costs (build plan Phase 3 risk: target p50 under
 * 5 ms). Run: pnpm --filter @wakeel/sandbox bench
 *
 * setup     inside the runner: new runtime, limits, new context, JSON.stringify captured
 * exec      whole pool round trip for `return 1`, as the caller sees it (adds the thread hop)
 */
import { SANDBOX_LIMITS } from "@wakeel/config";
import { SandboxPool } from "../../src/pool.ts";

const N = 2_000;
const WARMUP = 200;

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
const summary = (label: string, xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const f = (v: number) => v.toFixed(3);
  return `${label.padEnd(6)} p50 ${f(percentile(sorted, 0.5))} ms  p95 ${f(percentile(sorted, 0.95))} ms  p99 ${f(percentile(sorted, 0.99))} ms`;
};

const pool = new SandboxPool({ size: 1 });
await pool.start();
const setup: number[] = [];
const exec: number[] = [];
for (let i = 0; i < WARMUP + N; i++) {
  const started = performance.now();
  const outcome = await pool.exec({
    execId: `exec_bench_${i}`,
    kind: "code",
    source: "return 1;",
    timeoutMs: 1_000,
    memoryMb: SANDBOX_LIMITS.maxMemoryMb,
  });
  const elapsed = performance.now() - started;
  if (outcome.t !== "result") throw new Error(`unexpected outcome ${JSON.stringify(outcome)}`);
  if (i >= WARMUP) {
    setup.push(outcome.stats.setupMs);
    exec.push(elapsed);
  }
}
await pool.close();

process.stdout.write(`fresh context overhead over ${N} execs (one runner, Node ${process.version}, ${process.arch})\n`);
process.stdout.write(`${summary("setup", setup)}\n${summary("exec", exec)}\n`);
