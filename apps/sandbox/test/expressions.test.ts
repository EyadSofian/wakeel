import { SANDBOX_LIMITS } from "@wakeel/config";
import { AppError } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { errorOf, resultOf } from "./host";

/**
 * `kind: "expressions"` (ADR-018 §2–§3): `source` is a JSON array of expression sources, the value
 * is one outcome per expression in order, each in its own `try`, over deep-frozen scopes in strict
 * mode, with no fetch, platform calls or log.
 */

let pool: SandboxPool;
let n = 0;

beforeAll(async () => {
  pool = new SandboxPool({ size: 1 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

const scopes = {
  workflow: { count: 2, email: "a@b.example", tags: ["x"] },
  user: { name: "منى", attributes: { plan: "pro" } },
  conversation: {},
  bot: { storeName: "النور" },
  event: { text: "hello مرحبا" },
  env: { REGION: "eg" },
  turn: {},
};

const evaluate = (expressions: unknown, options: { timeoutMs?: number; memoryMb?: number } = {}) =>
  pool.exec({
    execId: `exec_expr_${++n}`,
    kind: "expressions",
    source: JSON.stringify(expressions),
    scopes,
    timeoutMs: options.timeoutMs ?? 1_000,
    memoryMb: options.memoryMb ?? SANDBOX_LIMITS.maxMemoryMb,
  });

describe("expression batches", () => {
  test("each expression has its own outcome, in request order", async () => {
    const outcome = await evaluate([
      "workflow.count * 21",
      "'أهلاً ' + user.name",
      "missingFunction()",
      "(",
      "undefined",
      "workflow.tags.map((t) => t.toUpperCase())",
      "user.attributes.plan === 'pro' && event.text.includes('مرحبا')",
      "null",
    ]);
    const value = resultOf(outcome).value as Record<string, unknown>[];
    expect(value).toHaveLength(8);
    expect(value[0]).toEqual({ ok: true, value: 42 });
    expect(value[1]).toEqual({ ok: true, value: "أهلاً منى" });
    expect(value[2]).toMatchObject({ ok: false });
    expect(String(value[2]?.["message"])).toMatch(/missingFunction/);
    expect(value[3]).toMatchObject({ ok: false });
    // `undefined` is an outcome with no value key (ADR-018 §2).
    expect(value[4]).toEqual({ ok: true });
    expect(value[5]).toEqual({ ok: true, value: ["X"] });
    expect(value[6]).toEqual({ ok: true, value: true });
    expect(value[7]).toEqual({ ok: true, value: null });
  });

  test("scopes are frozen: an assignment fails only that expression", async () => {
    const value = resultOf(await evaluate(["workflow.count = 5", "workflow.count", "env.REGION = 'x'"])).value as {
      ok: boolean;
    }[];
    expect(value.map((v) => v.ok)).toEqual([false, true, false]);
    expect(value[1]).toEqual({ ok: true, value: 2 });
  });

  test("scopePatches is always empty", async () => {
    expect(resultOf(await evaluate(["workflow.count + 1"])).scopePatches).toEqual({});
  });

  test("no fetch, platform calls, log or ctx", async () => {
    const names = ["fetch", "axios", "say", "tables", "kb", "ai", "log", "ctx"];
    const value = resultOf(await evaluate(names.map((name) => `typeof ${name}`))).value as { value: string }[];
    expect(value.map((v) => v.value)).toEqual(names.map(() => "undefined"));
  });

  test("a value that cannot become JSON fails only that expression", async () => {
    const value = resultOf(await evaluate(["10n", "1"])).value as { ok: boolean }[];
    expect(value.map((v) => v.ok)).toEqual([false, true]);
  });

  test("an expression cannot close the parentheses around it to run statements", async () => {
    const value = resultOf(await evaluate(["1); globalThis.leak = 1; (2", "typeof globalThis.leak"])).value as {
      ok: boolean;
      value?: unknown;
    }[];
    expect(value[0]?.ok).toBe(false);
    expect(value[1]).toEqual({ ok: true, value: "undefined" });
  });

  test("an expression that never ends fails the whole batch at the deadline", async () => {
    const e = errorOf(await evaluate(["1", "(() => { for (;;) {} })()"], { timeoutMs: 150 }));
    expect(e.code).toBe("code_timeout");
  });

  test("an empty batch gives an empty list", async () => {
    expect(resultOf(await evaluate([])).value).toEqual([]);
  });

  test.each([
    ["not JSON", "workflow.count"],
    ["not an array", { a: 1 }],
    ["not strings", [1, 2]],
  ])("a source that is %s is refused", async (_name, source) => {
    const run = pool.exec({
      execId: `exec_expr_${++n}`,
      kind: "expressions",
      source: typeof source === "string" ? source : JSON.stringify(source),
      scopes,
      timeoutMs: 1_000,
      memoryMb: SANDBOX_LIMITS.maxMemoryMb,
    });
    await expect(run).rejects.toBeInstanceOf(AppError);
    await expect(run).rejects.toMatchObject({ code: "validation_failed" });
  });
});
