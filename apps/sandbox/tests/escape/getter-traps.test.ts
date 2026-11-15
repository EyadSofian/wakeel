import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../../src/pool";
import { errorOf, resultOf, runWithHost } from "../../test/host";

/**
 * Escape suite (build plan 3.4, threat T2): getter traps. The host reads guest values (thrown
 * errors, return values, scope patches, log arguments, call inputs) only through QuickJS, under the
 * exec's deadline and memory limit, and never trusts what a getter or proxy does. A trap ends the
 * run with a code, never with a hard kill or a broken runner. This suite only grows.
 */

let pool: SandboxPool;

beforeAll(async () => {
  pool = new SandboxPool({ size: 1 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

const stillServing = async () => {
  const r = await runWithHost(pool, "return 'ok';");
  expect(resultOf(r.outcome).value).toBe("ok");
};

const LOOP = "for (;;) {}";
const trapProxy = (trap: string) =>
  `new Proxy({}, { get() { ${trap} }, has() { ${trap} }, ownKeys() { ${trap} }, getOwnPropertyDescriptor() { ${trap} }, getPrototypeOf() { ${trap} } })`;

describe("thrown values", () => {
  test.each([
    ["a proxy whose every trap throws", `throw ${trapProxy("throw new Error('trap');")};`],
    ["a proxy whose every trap loops", `throw ${trapProxy(LOOP)};`],
    ["an object whose toString loops", `throw { toString() { ${LOOP} } };`],
    ["an object whose Symbol.toPrimitive throws", "throw { [Symbol.toPrimitive]() { throw new Error('p'); } };"],
    [
      "an error whose stack getter loops",
      `const e = new Error('x'); Object.defineProperty(e, 'stack', { get() { ${LOOP} } }); throw e;`,
    ],
    [
      "an error whose name getter throws",
      "const e = new Error('x'); Object.defineProperty(e, 'name', { get() { throw 1; } }); throw e;",
    ],
  ])("%s ends the run without a hard kill", async (_name, source) => {
    const kills = pool.health().kills;
    const e = errorOf((await runWithHost(pool, source, { timeoutMs: 200 })).outcome);
    expect(["code_error", "code_timeout"]).toContain(e.code);
    expect(pool.health().kills).toBe(kills);
    await stillServing();
  });

  test("an object whose toString loops is reported without calling it", async () => {
    const e = errorOf((await runWithHost(pool, `throw { toString() { ${LOOP} } };`, { timeoutMs: 2_000 })).outcome);
    expect(e).toMatchObject({ code: "code_error", message: "an object was thrown" });
  });
});

describe("returned values", () => {
  test("a getter on the result that loops is stopped at the deadline", async () => {
    const kills = pool.health().kills;
    const e = errorOf((await runWithHost(pool, `return { get x() { ${LOOP} } };`, { timeoutMs: 150 })).outcome);
    expect(e.code).toBe("code_timeout");
    expect(pool.health().kills).toBe(kills);
  });

  test("a then getter on the result rejects the run as code_error", async () => {
    const e = errorOf(
      (await runWithHost(pool, "return { get then() { throw new Error('thenable trap'); } };")).outcome,
    );
    expect(e).toMatchObject({ code: "code_error", message: "thenable trap" });
  });

  test("a thenable that never calls back cannot hang the runner", async () => {
    const e = errorOf((await runWithHost(pool, "return { then() {} };", { timeoutMs: 2_000 })).outcome);
    expect(e.code).toBe("code_error");
    expect(e.message).toMatch(/never settle/);
  });

  test("a proxy as the result is read through its traps under the deadline", async () => {
    const kills = pool.health().kills;
    const e = errorOf((await runWithHost(pool, `return ${trapProxy(LOOP)};`, { timeoutMs: 150 })).outcome);
    expect(e.code).toBe("code_timeout");
    expect(pool.health().kills).toBe(kills);
  });

  test("overriding Promise.prototype.then does not change how the run ends", async () => {
    const r = await runWithHost(pool, "Promise.prototype.then = function () { return this; }; return 7;");
    expect(resultOf(r.outcome).value).toBe(7);
  });
});

describe("scope patches", () => {
  test("a variable getter that loops is stopped at the deadline", async () => {
    const kills = pool.health().kills;
    const source = `Object.defineProperty(workflow, "x", { enumerable: true, get() { ${LOOP} } });`;
    const e = errorOf((await runWithHost(pool, source, { timeoutMs: 150 })).outcome);
    expect(e.code).toBe("code_timeout");
    expect(pool.health().kills).toBe(kills);
  });

  test("a variable getter that throws is code_error and writes nothing", async () => {
    const source = "Object.defineProperty(workflow, 'x', { enumerable: true, get() { throw new Error('g'); } });";
    const r = await runWithHost(pool, source);
    expect(errorOf(r.outcome).code).toBe("code_error");
    expect(r.outcome).not.toHaveProperty("scopePatches");
  });

  test("a variable whose toJSON returns a different value each time is saved once, as JSON", async () => {
    const r = await runWithHost(pool, "let n = 0; workflow.x = { toJSON() { return ++n; } };");
    const patches = resultOf(r.outcome).scopePatches as { workflow?: { set?: Record<string, unknown> } };
    expect(typeof patches.workflow?.set?.["x"]).toBe("number");
  });
});

describe("call inputs and log arguments", () => {
  test("a getter in a call input that loops is stopped before anything is sent", async () => {
    const r = await runWithHost(pool, `await say({ type: "text", get text() { ${LOOP} } });`, {
      timeoutMs: 150,
      handlers: { say: () => null },
    });
    expect(errorOf(r.outcome).code).toBe("code_timeout");
    expect(r.calls).toEqual([]);
  });

  test("a getter on fetch options that loops is stopped before anything is sent", async () => {
    const r = await runWithHost(pool, `await fetch("https://a.example", { get method() { ${LOOP} } });`, {
      timeoutMs: 150,
      capabilityToken: "wkc1.x.y",
    });
    expect(errorOf(r.outcome).code).toBe("code_timeout");
  });

  test("a log argument whose toJSON loops is stopped at the deadline", async () => {
    const r = await runWithHost(pool, `log.info({ toJSON() { ${LOOP} } });`, { timeoutMs: 150 });
    expect(errorOf(r.outcome).code).toBe("code_timeout");
    expect(r.logs).toEqual([]);
  });

  test("a log argument whose toJSON throws is logged as text", async () => {
    const r = await runWithHost(pool, "log.info({ toJSON() { throw new Error('no'); } }); return 1;");
    expect(resultOf(r.outcome).value).toBe(1);
    expect(r.logs[0]?.args).toEqual(["[object Object]"]);
  });

  test("a log argument that is a trapping proxy is reported, not trusted", async () => {
    const r = await runWithHost(pool, `log.info(${trapProxy("throw new Error('t');")}); return 1;`);
    expect(resultOf(r.outcome).value).toBe(1);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]?.args).toEqual(["a value that cannot be shown"]);
  });
});
