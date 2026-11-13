# ADR-019 — Sandbox core: limits, back-pressure, result encoding and where the frames live

Status: proposed (implemented as proposed in task 3.2; review with that PR) · Date: 2026-11-13 · **Security-critical: changes need human review**

## Context

Task 3.2 builds the `apps/sandbox` core described in architecture §5.1 and ADR-003: a pool of worker threads, each with one QuickJS-WASM module, a fresh runtime per exec, memory and stack limits, a deadline interrupt, a hard kill 250 ms after the deadline, and the `POST /exec` NDJSON stream. The documents fix the shape but leave these questions open. Each was answered in the 3.2 PR with the recommendation below so the work could continue; each can change before merge.

Measurements quoted here come from the 3.2 branch on an Apple Silicon laptop, Node 22.23, `quickjs-emscripten-core` 0.32.0 with `@jitl/quickjs-wasmfile-release-sync` 0.32.0 (QuickJS 2025-09-13).

## 1. Which QuickJS package

ADR-003 names `quickjs-emscripten`. That package depends on four WASM builds (release and debug, sync and asyncify) and the core library.

- **A. `quickjs-emscripten`** as written.
- **B. `quickjs-emscripten-core` plus the one build we run, `@jitl/quickjs-wasmfile-release-sync`.** Same project, same API, same licence (MIT); the core README recommends this split.

**Recommendation: B**, pinned exactly. It ships one WASM file instead of four and keeps debug and asyncify builds out of the production image. Asyncify is not needed: host calls in 3.3 resolve guest promises from the host event loop, which the sync build supports.

## 2. Fresh runtime or fresh context

Architecture §5.1 says a fresh runtime per exec; the build-plan row says a fresh context.

**Recommendation: a fresh runtime and context per exec** (the stronger of the two: separate heap, atoms and shapes). Measured cost: p50 0.063 ms, p95 0.074 ms for runtime, limits, context and the captured `JSON.stringify`; p50 0.109 ms for the whole pool round trip of `return 1`. The target was p50 under 5 ms.

## 3. Interpreter stack and thread stack

The documents set no stack size. Testing found a host hazard: WASM frames run on the worker thread's own stack, and QuickJS's stack check measures only its own shadow stack. With the QuickJS limit too close to the thread stack, deep native recursion (`JSON.parse('['.repeat(2e6))`, `JSON.stringify` of deeply nested arrays) overflows the **host** thread with a V8 `RangeError` before QuickJS notices, leaving the module in an undefined state.

| QuickJS stack | thread stack | deep `JSON.parse` | deep `JSON.stringify` |
|---|---|---|---|
| 1 MB | 4 MB | host overflow | host overflow |
| 512 KB | 4 MB | clean | host overflow |
| 512 KB | 8 MB | clean | clean |
| 512 KB | 16 MB | clean | clean |

**Recommendation:** QuickJS stack 512 KB (about 2,300 frames of an ordinary function), thread stack 16 MB, and a unit test that keeps the ratio at 32× or more. Unbounded recursion reports `code_error` with the message "stack overflow". As a second line, any exception raised by the QuickJS host layer itself retires the runner instead of reusing it.

## 4. When every runner is busy

Architecture §15 sizes the pool at CPU cores × 2 but says nothing about waiting work.

- **A. Unbounded queue.** Never refuses; latency and memory grow without limit under load.
- **B. Bounded queue, refuse beyond it** with an existing code.
- **C. Bounded queue with a new `sandbox_busy` code** (contract change).

**Recommendation: B**, four waiting execs per runner, then `rate_limited` (429, `Retry-After: 1`) as a problem document before the stream starts. The worker treats it like any retryable dependency failure. Queue time does not count against the code's deadline; the deadline starts when a runner takes the exec. If operators need to tell sandbox saturation apart from API rate limiting, option C later.

## 5. Size of a request frame

**Recommendation:** 4 MB per NDJSON line (source, scopes and tool manifest together), `payload_too_large` (413) above it. State is capped at 256 KB (`STATE_MAX_BYTES`), so scopes fit with room for source and a large tool manifest.

## 6. Limits a caller may ask for

**Recommendation:** `limits.timeoutMs` 1 to 60,000 (the `code_timeout` fix promises up to 60 s), default `LIMITS.codeMs`; `limits.memoryMb` 1 to `LIMITS.codeMemoryMb` (64), default the same. Values above the maximum are refused with `validation_failed`, never clamped, so a caller never believes it has more than it gets.

## 7. Encoding the result

**Recommendation:** the code is the body of an async function; its `return` value is serialised inside the guest with the intrinsic `JSON.stringify` captured before the code runs, under the same deadline and memory limit (getters, `toJSON` and proxies run as guest code). No return value is `null`. A value that cannot become JSON (cycles, BigInt) is `code_error` "the return value cannot be turned into JSON: …". The prefix `(async () => {` shares the first line with the code, so line numbers need no mapping; columns on line 1 are shifted back. Columns are QuickJS's: for `throw new Error()` it points at `Error(`. Source maps are 3.3.

## 8. A promise that can never settle

`await new Promise(() => {})` with no pending jobs and no host operation in flight can never finish.

**Recommendation:** fail at once with `code_error` "the code awaits a promise that can never settle" instead of holding a runner until the deadline. From 3.3, a pending tool call or fetch counts as in flight, so this only fires when nothing can wake the code.

## 9. Out of memory that arrives as `null`

A flood of promise jobs fills the heap so fast that QuickJS cannot allocate its own "out of memory" error and throws `null`.

**Recommendation:** a `null` or `undefined` exception from a heap whose QuickJS estimate (`memory_used_size`) is at or above the limit is `code_memory_exceeded`; otherwise it is `code_error` "null". The measurement runs after the guest stopped, with the limit lifted for the measurement only. A program that holds that much data and then throws `null` itself is reported as a memory failure; nothing else can tell the two apart.

## 10. Where the frame schemas live

The zod schemas for request, tool-result, result and error frames are needed by the service and by the worker's client. `apps/*` may not be imported.

**Recommendation:** they live in `apps/sandbox/src/protocol.ts` for 3.2 (nothing else uses them yet) and move to `packages/sandbox-client/src/protocol.ts` in 3.3, where the service imports them from the client package. They are internal service frames, not part of the public contracts, so not `packages/contracts`.

## 11. Authenticating `POST /exec`

Architecture §5.3 relies on the network: only the worker can reach the sandbox. ADR-020 (egress, proposed) adds a shared bearer token as a second guard for egress.

**Recommendation:** add the same second guard to the sandbox in 3.3 (`SANDBOX_TOKEN`, sent by `packages/sandbox-client`), when the client exists to send it. 3.2 serves the stream on the internal network only, with no token, and binds to 127.0.0.1 by default.

## 12. Logging in the sandbox process

`@wakeel/telemetry` re-exports the audit writer, which imports `@wakeel/db`, so the sandbox process loads database code it never uses (no credentials: its environment has none).

**Recommendation:** add a `@wakeel/telemetry/logger` subpath export in a small follow-up and import only that in `apps/sandbox`, so the container image need not ship database drivers. Not done in 3.2 to stay inside its files.

## Consequences

- `SANDBOX_LIMITS` in `packages/config/src/sandbox.ts` holds every number above; `sandboxEnv` holds `SANDBOX_HOST`, `SANDBOX_PORT` (4300) and `SANDBOX_POOL_SIZE` (cores × 2).
- The escape suite in 3.4 should keep the deep-recursion cases from section 3 and add any new native recursion path found.
- If the WASM memory of a runner grows past 256 MB (freed runtimes do not shrink it), the runner is replaced after its exec finishes.

## Revisit when

QuickJS or Node changes how WASM frames use the thread stack; p95 queue time becomes visible in turn latency (resize the pool or adopt option 4C); or a tenant needs more than 64 MB or 60 s (a "heavy code" tier per ADR-003).
