import variant from "@jitl/quickjs-wasmfile-release-sync";
import { SANDBOX_LIMITS } from "@wakeel/config";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../../src/pool";
import { createHeapGuard } from "../../src/runner/heap";
import { errorOf, resultOf, runWithHost } from "../../test/host";

/**
 * Escape suite (build plan 3.4, threat T2): the memory limit holds against many allocations, and the
 * host never copies into a full heap. QuickJS built for WASM cannot measure its allocations, so its
 * own limit stops only a single allocation over it; the fixed WASM ceiling is what stops the rest
 * (docs/security/sandbox-review.md §2 and §3). This suite only grows.
 */

const MB = 1024 * 1024;
const LONG = { timeoutMs: 20_000 };

let pool: SandboxPool;

beforeAll(async () => {
  pool = new SandboxPool({ size: 1 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

const stillServing = async () => {
  const r = await runWithHost(pool, "return [1, 2, 3].map((n) => n * 2).join();");
  expect(resultOf(r.outcome).value).toBe("2,4,6");
};

describe("many allocations, each under the limit", () => {
  test.each([
    [
      "twenty 16 MB ArrayBuffers",
      "const a = []; for (let i = 0; i < 20; i++) a.push(new ArrayBuffer(16 * 1024 * 1024)); return a.length;",
    ],
    [
      "ten 30 MB strings",
      "const a = []; for (let i = 0; i < 10; i++) a.push(String.fromCharCode(97 + i).repeat(30 * 1024 * 1024)); return a.length;",
    ],
    ["three million small objects", "const a = []; for (let i = 0; i < 3e6; i++) a.push({ i }); return a.length;"],
    [
      "a 40 MB string and its JSON",
      "const s = 'x'.repeat(40 * 1024 * 1024); const t = JSON.stringify(s); return t.length + s.length;",
    ],
  ])("%s end with code_memory_exceeded", async (_name, source) => {
    const e = errorOf((await runWithHost(pool, source, LONG)).outcome);
    expect(e.code).toBe("code_memory_exceeded");
    expect(e.message).toBe(`used more than ${SANDBOX_LIMITS.maxMemoryMb} MB`);
    await stillServing();
  });

  test("what fits in the limit still runs", async () => {
    const r = await runWithHost(
      pool,
      "const a = []; for (let i = 0; i < 14; i++) a.push(new ArrayBuffer(4 * 1024 * 1024)); return a.length;",
      LONG,
    );
    expect(resultOf(r.outcome).value).toBe(14);
  });

  test("an exec that reached the ceiling leaves the next one its full heap", async () => {
    await runWithHost(pool, "const a = []; for (;;) a.push(new ArrayBuffer(1024 * 1024));", LONG);
    const r = await runWithHost(
      pool,
      "const a = []; for (let i = 0; i < 56; i++) a.push(new ArrayBuffer(1024 * 1024)); return a.length;",
      LONG,
    );
    expect(resultOf(r.outcome).value).toBe(56);
  });
});

describe("a lower limit from the caller", () => {
  test("holds against many allocations", async () => {
    const e = errorOf(
      (
        await runWithHost(
          pool,
          "const a = []; for (let i = 0; i < 6; i++) a.push(new ArrayBuffer(3 * 1024 * 1024)); return a.length;",
          { ...LONG, memoryMb: 8 },
        )
      ).outcome,
    );
    expect(e).toMatchObject({ code: "code_memory_exceeded", message: "used more than 8 MB" });
  });

  test("gives at least what was asked for", async () => {
    const r = await runWithHost(
      pool,
      "const a = []; for (let i = 0; i < 7; i++) a.push(new ArrayBuffer(1024 * 1024)); return a.length;",
      { ...LONG, memoryMb: 8 },
    );
    expect(resultOf(r.outcome).value).toBe(7);
  });

  test("of 1 MB still runs a small program", async () => {
    expect(resultOf((await runWithHost(pool, "return 6 * 7;", { memoryMb: 1 })).outcome).value).toBe(42);
  });
});

describe("host copies into a full heap", () => {
  const FILL =
    "globalThis.held = []; try { for (;;) held.push(new ArrayBuffer(64 * 1024)); } catch (e) {} try { for (;;) held.push({ n: held.length }); } catch (e) {}";

  test.each([
    ["5 KB", 5 * 1024],
    ["200 KB", 200 * 1024],
    ["3 MB", 3 * MB],
  ])("a %s tool result ends the run with code_memory_exceeded", async (_name, size) => {
    const r = await runWithHost(pool, `${FILL} const t = await ai.generate({ instructions: 'x' }); return t.length;`, {
      ...LONG,
      handlers: { "ai.generate": () => "Z".repeat(size) },
    });
    expect(errorOf(r.outcome).code).toBe("code_memory_exceeded");
    await stillServing();
  });

  test("a heap filled by scopes refuses the source instead of copying it", async () => {
    // 60 MB of scopes leave too little room for 2 MB of source and its copy.
    const r = await runWithHost(pool, `return ${JSON.stringify("s".repeat(2 * MB))}.length;`, {
      ...LONG,
      scopes: { workflow: { big: "x".repeat(30 * MB) } },
    });
    expect(errorOf(r.outcome).code).toBe("code_memory_exceeded");
    await stillServing();
  });
});

describe("the heap guard", () => {
  test("never writes below the module's first static address when the heap is full", async () => {
    const PAGE = 64 * 1024;
    const memory = new (
      globalThis as unknown as {
        WebAssembly: {
          Memory: new (d: { initial: number; maximum: number }) => ReturnType<QuickJSWASMModule["getWasmMemory"]>;
        };
      }
    ).WebAssembly.Memory({ initial: (16 * MB) / PAGE, maximum: (40 * MB) / PAGE });
    const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }));
    const runtime = quickjs.newRuntime();
    const ctx = runtime.newContext();
    const guard = createHeapGuard(ctx);
    const lowMemoryIsClean = () => new Uint8Array(memory.buffer, 0, 1024).every((b) => b === 0);
    try {
      expect(lowMemoryIsClean()).toBe(true);
      const filled = ctx.evalCode(
        "globalThis.held = []; try { for (;;) held.push(new ArrayBuffer(4096)); } catch (e) {} try { for (;;) held.push({}); } catch (e) {} held.length",
      );
      (filled.error ?? filled.value).dispose();
      for (const size of [10, 999, 5_000, 200_000, 2 * MB]) {
        const handle = guard.newString("Z".repeat(size));
        handle?.dispose();
        expect(handle, `${size} bytes`).toBeUndefined();
        expect(lowMemoryIsClean(), `${size} bytes`).toBe(true);
      }
    } finally {
      guard.dispose();
      ctx.dispose();
      runtime.dispose();
    }
  });
});
