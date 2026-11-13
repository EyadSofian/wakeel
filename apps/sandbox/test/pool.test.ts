import { SANDBOX_LIMITS } from "@wakeel/config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ExecOutcome, SandboxPool } from "../src/pool";
import type { ExecJobInput } from "../src/runner/messages";

/**
 * Integration: real worker threads running real QuickJS-WASM (build plan 3.2). Deadlines here are
 * real time because the code under test is a separate thread; nothing sleeps, every wait is for an
 * event from the pool. Limits are small so the suite stays fast.
 */

let pool: SandboxPool;
let n = 0;

const job = (source: string, limits: Partial<Pick<ExecJobInput, "timeoutMs" | "memoryMb">> = {}): ExecJobInput => ({
  execId: `exec_test_${++n}`,
  kind: "code",
  source,
  timeoutMs: limits.timeoutMs ?? 1_000,
  memoryMb: limits.memoryMb ?? SANDBOX_LIMITS.maxMemoryMb,
});

const run = (source: string, limits?: Partial<Pick<ExecJobInput, "timeoutMs" | "memoryMb">>) =>
  pool.exec(job(source, limits));

const errorOf = (outcome: ExecOutcome) => {
  if (outcome.t !== "error") throw new Error(`expected an error frame, got ${JSON.stringify(outcome)}`);
  return outcome;
};

const resultOf = (outcome: ExecOutcome) => {
  if (outcome.t !== "result") throw new Error(`expected a result frame, got ${JSON.stringify(outcome)}`);
  return outcome.value;
};

beforeAll(async () => {
  pool = new SandboxPool({ size: 2 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

describe("runs code", () => {
  test("the body is an async function; its return value is the result", async () => {
    expect(resultOf(await run("const a = 2; return a * 21;"))).toBe(42);
    expect(resultOf(await run("const x = await Promise.resolve({ ok: true, list: [1, 'b'] }); return x;"))).toEqual({
      ok: true,
      list: [1, "b"],
    });
  });

  test("no return gives null", async () => {
    expect(resultOf(await run("let a = 1;"))).toBeNull();
  });

  test("Arabic and mixed-direction text survives the round trip", async () => {
    const text = "مرحبا بك في Botbress، رقم الطلب ١٢٣";
    expect(resultOf(await run(`return ${JSON.stringify(text)};`))).toBe(text);
  });

  test("reports run and setup time", async () => {
    const outcome = await run("return 1;");
    if (outcome.t !== "result") throw new Error("expected a result");
    expect(outcome.stats.setupMs).toBeGreaterThanOrEqual(0);
    expect(outcome.stats.runMs).toBeGreaterThanOrEqual(0);
    expect(outcome.scopePatches).toEqual({});
  });

  test("the guest sees no host objects", async () => {
    const names = ["require", "process", "module", "console", "setTimeout", "setInterval", "fetch", "WebAssembly"];
    const out = resultOf(await run(`return ${JSON.stringify(names)}.map((n) => typeof globalThis[n]);`));
    expect(out).toEqual(names.map(() => "undefined"));
  });
});

describe("errors", () => {
  test("a thrown error is code_error with its line and column", async () => {
    const e = errorOf(await run("const a = 1;\nconst b = 2;\n  throw new Error('boom');"));
    // QuickJS points the column at the call that built the error: `Error(` on that line.
    expect(e).toMatchObject({ code: "code_error", message: "boom", line: 3, column: 18 });
  });

  test("columns on the first line are counted from the start of the caller's code", async () => {
    expect(errorOf(await run("null.x;"))).toMatchObject({ code: "code_error", line: 1, column: 5 });
  });

  test("a runtime type error is code_error", async () => {
    const e = errorOf(await run("\nnull.x;"));
    expect(e.code).toBe("code_error");
    expect(e.line).toBe(2);
    expect(e.message).toMatch(/null/);
  });

  test("throwing a non-error value is code_error with its text", async () => {
    expect(errorOf(await run("throw 'plain text';"))).toMatchObject({ code: "code_error", message: "plain text" });
  });

  test("a syntax error is code_syntax_error with its line", async () => {
    const e = errorOf(await run("const a = 1;\nlet x = ;"));
    expect(e.code).toBe("code_syntax_error");
    expect(e.line).toBe(2);
  });

  test("a value that cannot become JSON is code_error", async () => {
    const e = errorOf(await run("const a = {}; a.self = a; return a;"));
    expect(e.code).toBe("code_error");
    expect(e.message).toMatch(/JSON/);
  });

  test("awaiting a promise that can never settle fails at once instead of at the deadline", async () => {
    const started = Date.now();
    const e = errorOf(await run("await new Promise(() => {});", { timeoutMs: 5_000 }));
    expect(e.code).toBe("code_error");
    expect(e.message).toMatch(/never settle/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("deadline", () => {
  test("an infinite loop is interrupted at the deadline", async () => {
    const before = pool.health().kills;
    const started = Date.now();
    const e = errorOf(await run("for (;;) {}", { timeoutMs: 150 }));
    const elapsed = Date.now() - started;
    expect(e.code).toBe("code_timeout");
    expect(e.message).toContain("150 ms");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    // The interpreter's interrupt fired; the hard kill was not needed.
    expect(elapsed).toBeLessThan(150 + SANDBOX_LIMITS.killGraceMs);
    expect(pool.health().kills).toBe(before);
  });

  test("the guest cannot catch the interrupt", async () => {
    const e = errorOf(await run("try { for (;;) {} } catch (e) { return 'caught'; }", { timeoutMs: 100 }));
    expect(e.code).toBe("code_timeout");
  });

  test("an infinite loop in an async continuation is interrupted", async () => {
    const e = errorOf(await run("await null; while (true) {}", { timeoutMs: 100 }));
    expect(e.code).toBe("code_timeout");
  });

  test("catastrophic regular expression backtracking is interrupted", async () => {
    const e = errorOf(await run("return /^(a+)+$/.test('a'.repeat(40) + 'b');", { timeoutMs: 100 }));
    expect(e.code).toBe("code_timeout");
  });

  test("the pool keeps serving after a timeout", async () => {
    await run("for (;;) {}", { timeoutMs: 50 });
    expect(resultOf(await run("return 'still here';"))).toBe("still here");
  });
});

describe("memory", () => {
  test.each([
    ["a 1 GB ArrayBuffer", "const a = new ArrayBuffer(1024 * 1024 * 1024); return a.byteLength;"],
    // 10^9 characters: QuickJS refuses 2^30 and more as an invalid length before allocating.
    ["a 1 GB string", "const s = 'x'.repeat(1000 * 1000 * 1000); return s.length;"],
    ["an array that grows without end", "const a = []; for (;;) a.push({ n: a.length, s: 'payload' });"],
  ])("%s fails with code_memory_exceeded", async (_name, source) => {
    const e = errorOf(await run(source, { timeoutMs: 5_000 }));
    expect(e.code).toBe("code_memory_exceeded");
    expect(e.message).toContain(`${SANDBOX_LIMITS.maxMemoryMb} MB`);
  });

  test("a lower memory limit from the caller applies", async () => {
    const e = errorOf(await run("const a = new ArrayBuffer(8 * 1024 * 1024); return 1;", { memoryMb: 4 }));
    expect(e).toMatchObject({ code: "code_memory_exceeded" });
    expect(e.message).toContain("4 MB");
  });

  test("the pool keeps serving after running out of memory", async () => {
    await run("'x'.repeat(1000 * 1000 * 1000);");
    expect(resultOf(await run("return [1, 2, 3].length;"))).toBe(3);
  });
});

describe("stack", () => {
  test("unbounded recursion is code_error, not a crash", async () => {
    const e = errorOf(await run("function f() { return f() + 1; } return f();"));
    expect(e.code).toBe("code_error");
    expect(e.message).toMatch(/stack overflow/);
  });

  test.each([
    ["JSON.parse of deeply nested arrays", "return JSON.parse('['.repeat(2000000));"],
    ["JSON.stringify of deeply nested arrays", "let a = []; for (let i = 0; i < 1000000; i++) a = [a]; return a;"],
  ])("%s overflows inside the interpreter, not the host thread", async (_name, source) => {
    const kills = pool.health().kills;
    const e = errorOf(await run(source, { timeoutMs: 5_000 }));
    expect(e.code).toBe("code_error");
    expect(e.message).toMatch(/stack overflow/);
    expect(pool.health().kills).toBe(kills);
  });
});

describe("promise floods", () => {
  test("an endless microtask chain terminates at the deadline", async () => {
    const started = Date.now();
    const e = errorOf(
      await run("const f = () => Promise.resolve().then(f); f(); await new Promise(() => {});", { timeoutMs: 200 }),
    );
    expect(e.code).toBe("code_timeout");
    expect(Date.now() - started).toBeLessThan(200 + SANDBOX_LIMITS.killGraceMs);
  });

  test("an endless fan-out of promises terminates", async () => {
    // The job queue fills the heap so fast that QuickJS cannot even build its "out of memory" error.
    const e = errorOf(await run("for (;;) { Promise.resolve(1).then(() => {}); }", { timeoutMs: 5_000 }));
    expect(e.code).toBe("code_memory_exceeded");
  });

  test("throwing null on a small heap is still code_error", async () => {
    expect(errorOf(await run("throw null;"))).toMatchObject({ code: "code_error", message: "null" });
    expect(errorOf(await run("await Promise.reject(undefined);"))).toMatchObject({
      code: "code_error",
      message: "undefined",
    });
  });

  test("an endless chain of awaits terminates", async () => {
    const e = errorOf(await run("for (;;) { await null; }", { timeoutMs: 200 }));
    expect(e.code).toBe("code_timeout");
  });

  test("the pool keeps serving after a flood", async () => {
    expect(resultOf(await run("return await Promise.all([1, 2].map(async (x) => x * 2));"))).toEqual([2, 4]);
  });
});

describe("isolation", () => {
  test("two concurrent execs cannot see each other's globals", async () => {
    // Both hold their worker for 150 ms so they overlap; each writes a global and a prototype
    // property, then reports what it can see of the other.
    const body = (me: string, other: string) => `
      globalThis.marker_${me} = '${me}';
      Object.prototype.polluted_${me} = true;
      Array.prototype.push = () => 'hijacked by ${me}';
      const until = Date.now() + 150;
      while (Date.now() < until) {}
      return {
        mine: globalThis.marker_${me},
        theirs: typeof globalThis.marker_${other},
        theirPrototype: ({}).polluted_${other} === undefined,
      };`;
    const [a, b] = await Promise.all([run(body("a", "b")), run(body("b", "a"))]);
    expect(resultOf(a)).toEqual({ mine: "a", theirs: "undefined", theirPrototype: true });
    expect(resultOf(b)).toEqual({ mine: "b", theirs: "undefined", theirPrototype: true });
  });

  test("a later exec on the same worker starts with fresh globals and built-ins", async () => {
    const single = new SandboxPool({ size: 1 });
    await single.start();
    try {
      const first = await single.exec(
        job("globalThis.leak = 'secret'; Object.prototype.leak = 1; JSON.stringify = () => 'x'; return 1;"),
      );
      expect(resultOf(first)).toBe(1);
      const second = await single.exec(
        job("return [typeof globalThis.leak, ({}).leak === undefined, JSON.stringify({ a: 1 })];"),
      );
      expect(resultOf(second)).toEqual(["undefined", true, '{"a":1}']);
    } finally {
      await single.close();
    }
  });
});

describe("pool", () => {
  test("more execs than workers queue and all finish", async () => {
    // Two runners plus a queue of eight (four per runner).
    const outcomes = await Promise.all(Array.from({ length: 10 }, (_, i) => run(`return ${i} * 2;`)));
    expect(outcomes.map(resultOf)).toEqual(Array.from({ length: 10 }, (_, i) => i * 2));
  });

  test("health reports the pool", () => {
    expect(pool.health()).toMatchObject({ ready: true, size: 2, live: 2, queued: 0 });
  });

  test("aborting an exec stops it and frees the worker", async () => {
    const controller = new AbortController();
    const pending = pool.exec(job("for (;;) {}", { timeoutMs: 10_000 }), { signal: controller.signal });
    const started = Date.now();
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toThrow();
    expect(resultOf(await run("return 'free';"))).toBe("free");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("aborting a queued exec removes it from the queue", async () => {
    const single = new SandboxPool({ size: 1 });
    await single.start();
    try {
      const busy = single.exec(job("const until = Date.now() + 100; while (Date.now() < until) {} return 1;"));
      const controller = new AbortController();
      const queued = single.exec(job("return 2;"), { signal: controller.signal });
      expect(single.health().queued).toBe(1);
      controller.abort();
      await expect(queued).rejects.toThrow();
      expect(single.health().queued).toBe(0);
      expect(resultOf(await busy)).toBe(1);
    } finally {
      await single.close();
    }
  });

  test("a full queue refuses new work with rate_limited", async () => {
    const tiny = new SandboxPool({ size: 1, queueLimit: 1 });
    await tiny.start();
    try {
      const busy = tiny.exec(job("const until = Date.now() + 100; while (Date.now() < until) {} return 1;"));
      const queued = tiny.exec(job("return 2;"));
      await expect(tiny.exec(job("return 3;"))).rejects.toMatchObject({ code: "rate_limited" });
      expect([resultOf(await busy), resultOf(await queued)]).toEqual([1, 2]);
    } finally {
      await tiny.close();
    }
  });

  test("kinds other than code are refused until their guest layer exists", async () => {
    await expect(pool.exec({ ...job("1"), kind: "expressions" })).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("overhead", () => {
  test("a fresh runtime and context per exec costs well under 5 ms at p50", async () => {
    const setup: number[] = [];
    for (let i = 0; i < 200; i++) {
      const outcome = await run("return 1;");
      if (outcome.t !== "result") throw new Error("expected a result");
      setup.push(outcome.stats.setupMs);
    }
    setup.sort((a, b) => a - b);
    expect(setup[100]).toBeLessThan(5);
  });
});
