import { availableParallelism } from "node:os";
import { LIMITS } from "@wakeel/contracts";
import { z } from "zod";
import { defineEnv } from "./env";

/**
 * The code sandbox service (architecture §5, ADR-003, build plan 3.2). Its environment holds only
 * this: no database, Redis or object-store credentials ever reach it (architecture §5.3, layer 2).
 */
export const sandboxEnv = defineEnv({
  sandboxHost: {
    env: "SANDBOX_HOST",
    schema: z.string().min(1).default("127.0.0.1"),
    description: "Interface the sandbox service listens on. 127.0.0.1 by default; containers set 0.0.0.0.",
  },
  sandboxPort: {
    env: "SANDBOX_PORT",
    schema: z.coerce.number().int().min(1).max(65_535).default(4300),
    description: "TCP port the sandbox service listens on.",
  },
  sandboxPoolSize: {
    env: "SANDBOX_POOL_SIZE",
    // Architecture §15: CPU cores × 2 per replica.
    schema: z.coerce
      .number()
      .int()
      .min(1)
      .default(availableParallelism() * 2),
    description: "Worker threads that run code at once in this replica. Unset means two per CPU core.",
  },
  sandboxEgressUrl: {
    env: "EGRESS_URL",
    schema: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:4400"),
    // The sandbox authenticates each guest fetch with the exec's capability token, so it is never
    // given EGRESS_TOKEN (ADR-023 §4).
    description: "Base URL of the egress service the guest fetch goes through, for example http://egress:4400.",
  },
  sandboxRuntimeVerified: {
    env: "SANDBOX_RUNTIME_VERIFIED",
    // Architecture §5.3, layer 3: production boot refuses to start without it.
    schema: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    description:
      "1 once the deploy pipeline has checked that this container runs under gVisor (runsc). Required when NODE_ENV=production; leave unset elsewhere.",
  },
});

/**
 * Limits for one execution and for the threads that run them. Callers may ask for a shorter time or
 * less memory than the maximum, never more (ADR-019).
 */
export const SANDBOX_LIMITS = {
  defaultTimeoutMs: LIMITS.codeMs,
  /** The `code_timeout` fix promises a card's time limit can go up to 60 s. */
  maxTimeoutMs: 60_000,
  defaultMemoryMb: LIMITS.codeMemoryMb,
  maxMemoryMb: LIMITS.codeMemoryMb,
  /** A runner still busy this long after its deadline is terminated (architecture §5.1). */
  killGraceMs: 250,
  /** QuickJS's own stack limit: about 2,300 frames of an ordinary function. */
  interpreterStackBytes: 512 * 1024,
  /**
   * Stack of each worker thread. WASM frames run on it, so it must stay at least 32 times the
   * interpreter stack or deep native recursion overflows the host before QuickJS notices (ADR-019).
   */
  threadStackMb: 16,
  /** V8 heap of each worker thread: holds the source, the result text and the WASM glue. */
  threadHeapMb: 512,
  /**
   * WASM memory each runner's QuickJS module starts with. It is the variant's own initial size, so the
   * module loads unchanged.
   */
  wasmMemoryInitialMb: 16,
  /**
   * The module's WASM memory can never pass `maxMemoryMb` plus this: room for its static data and C
   * stack, and for the last growth step Emscripten cannot take (it grows by at least 5%). With it, a
   * guest gets about `maxMemoryMb` of heap. QuickJS's own memory limit is not enough on its own: built
   * for WASM it cannot measure an allocation's size, so it refuses one allocation over the limit but
   * not many smaller ones (docs/security/sandbox-review.md §2). The fixed ceiling makes `malloc` fail,
   * which QuickJS reports as "out of memory".
   */
  wasmMemoryOverheadMb: 6,
  /** Execs waiting per runner before the pool answers `rate_limited`. */
  queuePerRunner: 4,
  /** Largest NDJSON frame the service reads (source, scopes and tool manifest together). */
  requestFrameBytes: 4 * 1024 * 1024,
} as const;
