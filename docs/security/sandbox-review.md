# Code sandbox security review (task 3.4 🔒)

For the human review the build plan requires on 3.4 (threat T2, architecture §5.3 and §16). This file says what the sandbox guarantees, how, what proves it, and what is still open. Read it with ADR-003, ADR-019 (proposed, sandbox core) and ADR-023 (proposed, guest API).

Status: ✅ done and tested · ⏳ later task · ⚠️ known gap (accepted or open)

## 1. What the sandbox is

`apps/sandbox` runs tenant- and model-written JavaScript. It is an internal HTTP service with one route that matters, `POST /exec`: a bidirectional NDJSON stream carrying one exec request, the guest's tool calls and logs, the caller's tool results, and the outcome. Each exec runs in a fresh QuickJS runtime inside one worker thread of a pool; each thread holds its own QuickJS WASM module and runs one exec at a time.

The four layers of architecture §5.3, and what enforces each here:

| Layer | Enforced by | Where |
|---|---|---|
| 1. Interpreter | QuickJS in WASM linear memory, no JIT, a fresh runtime per exec; a deadline interrupt; a fixed WASM memory ceiling (§2); the interpreter's stack limit; the only bridge is two functions that take and return JSON text (ADR-023 §1) | `src/runner/*`, `src/guest/*` |
| 2. Thread and process | One exec per thread; `worker.terminate()` 250 ms after the deadline; the runner thread gets an empty environment; the capability token never leaves the pool's thread; the service's own environment holds no database, Redis, object-store or egress credentials | `src/pool.ts`, `packages/config/src/sandbox.ts` |
| 3. Container | Distroless image, non-root, read-only root, all capabilities dropped, `no-new-privileges`, Docker's default seccomp profile, gVisor in production; boot refuses production without `SANDBOX_RUNTIME_VERIFIED=1` | `apps/sandbox/Dockerfile`, `src/boot.ts` |
| 4. Network | The guest's `fetch` goes only to egress, with the exec's capability token (ADR-023 §4); egress does the SSRF checks (`docs/security/egress-review.md`) | `src/egress-client.ts` |

## 2. Finding: the QuickJS memory limit stopped only single allocations

The escape suite found that `runtime.setMemoryLimit(64 MB)` did not hold. Twenty 16 MB `ArrayBuffer`s, ten 30 MB strings or three million small objects all ran to completion under a 64 MB limit, using 160 to 335 MB.

**Cause.** QuickJS counts memory with `malloc_usable_size`. Built for WASM by Emscripten that function returns 0, so QuickJS adds only its 8-byte overhead per allocation to its running total. The check `total + size > limit` then refuses only one allocation larger than the limit by itself. The 3.2 memory tests passed because each of them needed one such allocation (a 1 GB buffer, an array whose backing store outgrew 64 MB in one `realloc`).

**Fix.** Each runner's module now gets a `WebAssembly.Memory` with a fixed maximum: `maxMemoryMb` + `wasmMemoryOverheadMb` (64 + 6 MB). When the heap reaches it, `malloc` itself fails and QuickJS raises "out of memory". A guest gets about 63.75 MB of `ArrayBuffer`s. The module is loaded with `newVariant(variant, { wasmMemory })` (quickjs-emscripten-core 0.32.0), and the runner checks that the module took that memory before taking work.

- **A caller's lower `memoryMb`** cannot change the module's ceiling, so the difference is held back: before the guest runs, the runner allocates one `ArrayBuffer` of `64 − memoryMb − 2` MB that only the host holds. Measured: an 8 MB limit gives 9 MB, a 4 MB limit 5 MB, a 1 MB limit 3.25 MB. The 2 MB returned makes up for fragmentation around the held block, so a guest gets at least what it asked for, never far more.
- **A `null` exception.** When the heap is full, QuickJS often cannot build its own "out of memory" error and throws `null`. A nullish exception is reported as `code_memory_exceeded` when the module's memory is within 5% of its ceiling. Emscripten grows memory by at least 5% at a time and gives up when that step passes the maximum, so a full heap stops short of the ceiling, never at it.
- **The WASM memory never shrinks**, so a runner whose exec came within 5% of the ceiling is replaced when that exec ends. The next exec on any runner starts with its full heap, and the "near the ceiling" signal always describes the exec that is running. The old rule (replace a runner past 256 MB) is gone: memory can no longer reach 256 MB.

## 3. Finding: host copies into a full heap wrote through a null pointer

While testing §2, a tool result delivered into a full heap ended with "memory access out of bounds". quickjs-emscripten 0.32.0 copies a string into WASM memory like this (`newHeapCharPointer`):

```
ptr = _malloc(length + 1); stringToUTF8(text, ptr, length + 1)
```

The pointer is not checked. On a full heap `_malloc` returns 0, and the text is written from address 0 upwards. The module's static data starts at byte 1024, so any copy over about 1 KB overwrote it. Measured with a capped module: a 5,000-byte `newString` on a full heap wrote 5,000 bytes from address 0, and `typeof` of the handle it returned was "unknown". The same path is used for the source code (`evalCode`), the scopes (the prelude's configuration) and every tool and fetch result. A guest that filled its heap and then awaited a tool result could have the result, possibly bytes an attacker controls (a fetch body), written over QuickJS's own data. That data is inside WASM, but it is the interpreter's state for the rest of the exec and for every later exec on that runner.

**Fix.** Every copy of outside text goes through a heap guard (`src/runner/heap.ts`):

1. Before any guest code runs, a closure capturing the intrinsic `ArrayBuffer` constructor is created; the guest can never reach it.
2. Before each copy of `n` bytes, the guard calls it to allocate `2n + 64 KB` through QuickJS's own allocator, which checks for failure. If that fails, nothing is copied and the exec ends as `code_memory_exceeded`.
3. Otherwise the buffer is freed at once and the copy is made. No guest code runs between the probe and the copy, so the host's `_malloc` takes space the probe just held. The probe is twice the text because QuickJS makes its own copy of it.
4. A handle that is not a string afterwards (QuickJS's own copy failed) is treated the same way.

Short copies are probed too: written at address 0 they would sit where a failed 8-byte value box points, and could be read back as a value. The only unprobed copies are the library's own short fixed strings (property names such as `message`), which land below byte 1024, where nothing else lives.

The guard was tried 200 times against full heaps with 4 KB to 1 MB holes freed in different patterns: no write below byte 1024 in any trial; 10 trials were refused at step 4 with the probe at `n + 64 KB`, which is why it is `2n + 64 KB`. The test `the heap guard never writes below the module's first static address when the heap is full` keeps it.

This should also be reported upstream to quickjs-emscripten (open question Q3).

## 4. Other escape-suite fixes

- **Deeply nested scopes stuck a runner.** The pool sent the scopes to the runner with `postMessage`, whose structured clone overflowed the stack on 100,000 nested arrays. It threw after the runner was marked busy, so that runner never took work again. The scopes are now turned into JSON text on the pool's thread before any runner is involved; a value that cannot be is refused as `validation_failed` on `scopes`. The secrets to redact are worked out there too, so the runner receives only text and numbers. A `postMessage` that throws anyway settles the exec as `internal_error` and frees the runner.
- **`__proto__`, `constructor` and `prototype` as variable names.** A guest could define an own, enumerable `workflow.__proto__`; the snapshot dropped it silently, and `constructor` and `prototype` went into `scopePatches`. A worker that applies a patch with plain property writes would then reach a prototype. A patch now never carries these names: the prelude's snapshot throws `code_error` "workflow.__proto__ cannot be saved: __proto__ is not a variable name", and the host's patch parser refuses them as well. A key with one of these names that arrived in the scopes and was not changed is allowed.
- **A 413 the caller could not read.** On a request frame over 4 MB, the service answered 413 and destroyed the socket while the caller was still uploading, so the caller saw `EPIPE` instead of the answer. It now reads and discards the rest of the body, never holding more than one frame, and closes the connection after 10 s if the body has not ended.
- **Running out of memory while saving variables** was reported as `code_error` "workflow.big cannot be saved: out of memory". The snapshot now lets out-of-memory and interrupt errors through unchanged, so they are `code_memory_exceeded` and `code_timeout`.
- **Scopes too large for the heap** were `internal_error`. Installing the guest API now tells a full heap (`code_memory_exceeded`) and nesting deeper than the interpreter's stack (`code_error`) apart from a fault of its own (`internal_error`).

## 5. Container

`apps/sandbox/Dockerfile`, built from the repository root. The build stage (`node:22.23.2-bookworm-slim`) runs `pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@wakeel/sandbox..."`: 39 packages, no install scripts. The runtime stage is `gcr.io/distroless/nodejs22-debian12:nonroot` (Node 22.22.0): no shell and no package manager, uid 65532. Both base images are pinned by digest. `.dockerignore` keeps out `.env` files at any depth, `.git`, `.claude`, tests, docs and tools. `/app` is 35 MB and holds no `.env`, `.claude` or test file of ours.

`tsx` loads the TypeScript, as in development (`node --import tsx src/main.ts`); the runner threads inherit the flag. `TSX_DISABLE_CACHE=1` keeps tsx from writing a cache to `/tmp`, which is read-only. `tsx` is now a dependency of `@wakeel/sandbox` (it already ran `start`), so the production install includes it.

The image cannot set the rest of layer 3; the deployment must:

```
docker run --read-only --cap-drop ALL --security-opt no-new-privileges \
  --runtime runsc -e SANDBOX_RUNTIME_VERIFIED=1 -p 4300:4300 wakeel-sandbox
```

Verified on Docker 29.8.2 (runc; gVisor is not installed here):

| Check | Result |
|---|---|
| Production boot without `SANDBOX_RUNTIME_VERIFIED=1` | Exits 1 with fatal `sandbox_runtime_unverified` and the fix in the message |
| User | `Uid: 65532 65532 65532 65532` |
| Capabilities | `CapInh`, `CapPrm`, `CapEff`, `CapBnd`, `CapAmb` all `0000000000000000` |
| `no-new-privileges` | `NoNewPrivs: 1` |
| Seccomp | `Seccomp: 2` (filter mode), 1 filter: Docker's default profile |
| Read-only root | Writes to `/app`, `/tmp` and `/home/nonroot` fail with `EROFS` |
| Service | `/health/ready` 200 with 2 runners; an exec returns Arabic text intact, the secret redacted in its log line, the right patch; twenty 16 MB buffers end with `code_memory_exceeded` |

## 6. Checklist

| # | Item | Status | Evidence (`apps/sandbox/tests/escape/` unless named) |
|---|---|---|---|
| S1 | No host object, function or global is reachable from the guest | ✅ | `host-probing`: no Node, Deno, Bun or QuickJS libc globals; walking every object from `globalThis` finds no host function; the bridge's `call` is unreachable; caller chains never reveal the prelude |
| S2 | Error stacks and API source name no host path or value | ✅ | `host-probing`: "error stacks name only the guest's own files", "the API functions' source names no host value" |
| S3 | The capability token never reaches the guest | ✅ | `host-probing`: "the capability token is nowhere in the guest's reach"; the pool strips it before `postMessage` |
| S4 | Polluted prototypes never reach the host or a later exec | ✅ | `prototype-pollution`: tool inputs stay plain, `__proto__` in results and scopes is an own key, a later exec sees clean prototypes |
| S5 | A patch never carries `__proto__`, `constructor` or `prototype` | ✅ | `prototype-pollution`: "a variable named __proto__ cannot be written back", "a variable named constructor / prototype cannot be written back" |
| S6 | Replacing built-ins breaks only the guest's own run | ✅ | `prototype-pollution`: "replacing the built-ins the guest API uses…"; `getter-traps`: "overriding Promise.prototype.then…" |
| S7 | Getters, `toJSON`, proxies and thenables run as guest code, under the deadline | ✅ | `getter-traps`: 14 tests over thrown values, results, patches, call inputs and log arguments |
| S8 | Calls made while the host reads guest values cannot confuse it | ✅ | `reentrancy`: calls from `toJSON`, from an error's message getter, during the snapshot, from a log argument |
| S9 | Answers the host does not expect reach nothing | ✅ | `reentrancy`: double answers, answers after the end, an answer for another exec with the same call id |
| S10 | Call and log floods stop at 500 calls and 200 log lines | ✅ | `reentrancy`: "floods" |
| S11 | The memory limit holds against many allocations, each under it | ✅ | `memory-ceiling`: 16 MB buffers, 30 MB strings, small objects, a string and its JSON |
| S12 | A lower `memoryMb` holds, and gives at least what was asked | ✅ | `memory-ceiling`: "a lower limit from the caller" |
| S13 | A host copy into a full heap never writes through a null pointer | ✅ | `memory-ceiling`: "host copies into a full heap" (5 KB, 200 KB, 3 MB results; a source after large scopes); "the heap guard never writes below…" |
| S14 | Oversized payloads in every direction end with a code, never take the service down, never need a hard kill | ✅ | `oversized-payloads`: 13 tests from the guest, the host and the HTTP edge |
| S15 | Input that cannot be sent to a runner never leaves one busy | ✅ | `oversized-payloads`: "deeply nested scopes fail the run, not the service" |
| S16 | CPU, stack and promise floods end at the deadline or with a code | ✅ | `test/pool.test.ts` (3.2): loops, recursion, deep JSON, microtask chains, promise fan-out, hard kill |
| S17 | Secrets are redacted from log lines and error messages | ✅ | `test/guest.test.ts` (3.3); verified in the container |
| S18 | Container: non-root, read-only root, no capabilities, `no-new-privileges`, seccomp filter | ✅ | §5, by hand on Docker 29.8.2. ⚠️ Not yet an automated test |
| S19 | Production refuses an unverified runtime | ✅ | `test/boot.test.ts`; `packages/config/test/sandbox.test.ts` (only `0` or `1`); §5 |
| S20 | gVisor (`runsc`) in production | ⏳ | Deployment work; cannot run on this machine: its Docker has only runc |
| S21 | External penetration test | ⏳ | Architecture §16 |

## 7. Known gaps and decisions for the reviewer

1. **gVisor is untested.** The image has never run under `runsc`. The flag check makes production depend on the pipeline; nothing yet checks the runtime itself.
2. **The container checks in §5 were made by hand.** A CI job that builds the image and asserts them (exit code without the flag, `/proc/self/status`, `EROFS`) is not written yet.
3. **The sandbox image carries the database driver.** `@wakeel/telemetry` depends on `@wakeel/db`, so drizzle-orm and pg are installed in a service that must never reach a database. It holds no credentials, so this is code that should not be there, not access. Fix: move what telemetry takes from `db` into a package the sandbox can use without it.
4. **The memory numbers are approximate.** A guest gets about 63.75 MB under the 64 MB maximum, and a lower limit 1 to 2 MB over what it asked for. The reported message stays "used more than N MB".
5. **Two signals depend on library internals**, each pinned by a test: the `null` classification relies on Emscripten's 5% growth step (§2), and the guard relies on `_malloc` reusing the space a probe just freed (§3). Upgrading quickjs-emscripten means rerunning `memory-ceiling.test.ts` and the §3 trials.
6. **The contracts still allow these names.** `Identifier` (`docs/04-contracts/common.ts`) accepts `__proto__`, `constructor` and `prototype`, so a bot could declare a variable its code can never save. The sandbox refuses them (S5); the contract should too (Q2).
7. **The build and runtime images differ in Node patch version** (22.23.2 to install, 22.22.0 to run). Nothing native is installed, so this is harmless today.
8. **Seccomp is Docker's default profile**, not one written for this service. A narrower profile is possible once gVisor is in place; under gVisor most syscalls never reach the host kernel anyway.

## 8. Questions for the reviewer

- **Q1.** Is a fixed 70 MB WASM ceiling per runner, plus a host-held block for lower limits, the design you want for T2? The alternative is a QuickJS build with its own allocator accounting, which means maintaining a custom WASM variant. Recommended: keep the ceiling.
- **Q2.** May `Identifier` refuse `__proto__`, `constructor` and `prototype`? That is a contract change and needs its own ADR. Recommended: yes.
- **Q3.** May I report the unchecked `_malloc` in `newHeapCharPointer` to quickjs-emscripten as a public issue? It is a memory-safety bug in a public library; the report would describe it without naming this project. Recommended: yes.
- **Q4.** Should the container checks in §5 run in CI on every change to `apps/sandbox`? Recommended: yes, as a follow-up task.
