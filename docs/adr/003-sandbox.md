# ADR-003 — Code sandbox: QuickJS-WASM in an isolated runner service, gVisor in production

Status: accepted · Date: 2026-11-13 · **Security-critical: changes need human review**

## Context
Three kinds of untrusted JavaScript run on every tenant's behalf: Execute Code cards and code tools (written by builders), template and condition expressions, and Autonomous Node run blocks (written by a model that reads end-user text). The platform is multi-tenant. The brief asks to choose between isolated-vm in per-tenant worker pools and a microVM (Firecracker, gVisor), and to threat-model both.

## Threat model

| Attacker goal | isolated-vm pools | Firecracker microVM | **QuickJS-WASM + runner service + gVisor (chosen)** |
|---|---|---|---|
| Read host memory or other tenants' data in the same process | One V8 bug away: isolates share the engine and process with the host; JIT bugs are regular | Not possible short of a hypervisor escape | Needs a QuickJS bug **and** a WASM-runtime (V8) bug **and** then finds a process with no credentials |
| Reach DB, Redis, object store | Worker process usually has credentials | No, if the VM is given none | Runner has none |
| Pivot to the internal network | Needs process compromise | Blocked by VM networking | Blocked: only the egress proxy is routable |
| Exhaust CPU or memory | Isolate limits; a tight loop can still stall the event loop until the watchdog fires | cgroup limits | Interpreter interrupt, memory limit, thread kill, container limits |
| Persist between executions | Pooled isolates can leak state unless recreated | Fresh VM or snapshot restore | Fresh runtime per execution |
| Supply-chain: native addon | Native build per Node version; needs `--no-node-snapshot` | Kernel + rootfs to maintain | Pure WASM; no native code |
| Operational burden | Low | High: KVM hosts, image pipeline, pool manager, ~125 ms+ cold start, not available on most PaaS | Low to medium: one extra service; gVisor is a container runtime flag |

Verified facts: isolated-vm's README says it is in maintenance mode and that using it "does not automatically make your application safe". Botpress LLMz moved to QuickJS-WASM. Typebot uses isolated-vm with a bridged fetch.

## Decision
1. **Interpreter**: QuickJS compiled to WASM (`quickjs-emscripten`), a fresh runtime per execution, memory and stack limits, deadline interrupt.
2. **Process boundary**: a separate service `apps/sandbox` with no data-store credentials; executions run in pooled worker threads that are terminated on overrun.
3. **Container boundary**: non-root, read-only filesystem, no capabilities, seccomp; `runsc` (gVisor) required in production.
4. **Network boundary**: the only reachable address is the egress proxy (SSRF guard, DNS pinning, per-workspace rate limit).
5. **No fallback**: if QuickJS cannot load, the service is unhealthy. There is no `vm`, `eval` or `Function` path anywhere in the repo (lint rule).
6. Tools and data access happen in the worker via the exec stream; the guest only sees JSON.

## What we give up
- Speed: an interpreter is 20–50× slower than JIT for pure computation. Acceptable: tenant code is glue around I/O. Limit is 10 s by default.
- npm packages and Node APIs in tenant code. Not offered. A fixed helper set is provided.
- `Intl` and some newer built-ins are missing in QuickJS; documented, with helpers for dates and number formatting.

## Alternatives considered
- **isolated-vm per-tenant pools**: rejected as the primary boundary (shared engine with a credentialed process, maintenance mode). Per-tenant pools reduce cross-tenant exposure but not host exposure.
- **Firecracker**: the strongest boundary and the right answer if we ever run arbitrary packages or Python. Rejected for the MVP on operational cost for a small team; kept as the documented upgrade for a "heavy code" tier.
- **Third-party sandbox APIs (E2B and similar)**: sends tenant code and secrets to another processor and adds latency per call; conflicts with data-residency positioning.

## Consequences
- An escape test suite is part of CI and must grow with every reported technique.
- An external penetration test of the sandbox and egress proxy happens before the first paying tenant.
- Deploy targets must support a custom container runtime; on platforms that cannot run gVisor the operator must accept and record the reduced isolation.

## Revisit when
Tenants need npm packages or long-running compute; a QuickJS or WASM-runtime escape is published; or p95 code execution time becomes a product complaint.
