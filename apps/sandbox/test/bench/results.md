# Context-overhead bench results

The build plan sets a target for Phase 3: a fresh runtime and context per exec should cost less than 5 ms at p50. The bench is `test/bench/context-overhead.ts`. It runs 2,000 execs of `return 1;` on one runner, after 200 warm-up execs.

```bash
pnpm --filter @wakeel/sandbox bench
```

- `setup` is measured inside the runner. It covers the new runtime, the memory, stack and interrupt limits, the new context, and capturing `JSON.stringify`.
- `exec` is the whole pool round trip as the caller sees it, so it also includes the hop between threads.

| Date | Machine | Node | QuickJS | setup p50 / p95 / p99 | exec p50 / p95 / p99 |
|---|---|---|---|---|---|
| 2026-11-13 | Apple M5 Pro, 15 cores, arm64 | 22.23.2 | quickjs-emscripten-core 0.32.0, release-sync | 0.069 / 0.127 / 0.222 ms | 0.126 / 0.274 / 0.470 ms |

The p50 is about 40 times under the target. Add a row when QuickJS, Node or the setup steps change.
