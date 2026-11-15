import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { errorOf, resultOf, runWithHost, ToolError } from "./host";

/**
 * Integration: the guest API (architecture §5.2, ADR-022, ADR-023) over real worker threads and
 * QuickJS. The host side is a stand-in worker that answers tool calls.
 */

let pool: SandboxPool;

beforeAll(async () => {
  pool = new SandboxPool({ size: 2 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

const scopes = () => ({
  bot: { storeName: "النور", openHours: { from: 9, to: 21 } },
  user: { plan: "free", phone: null, attributes: { tier: "gold" } },
  conversation: { language: "ar", cart: { items: [{ sku: "A1", qty: 1 }] } },
  workflow: { orderNumber: "١٢٣", attempts: 0, tags: ["new"] },
  event: { kind: "message", text: "وين طلبي؟ where is my order", payload: {}, metadata: {} },
  env: { SHOP_API_KEY: "sk-live-9f8e7d6c5b4a", SHOP_URL: "https://shop.example" },
  turn: {},
});

const run = (source: string, options: Parameters<typeof runWithHost>[2] = {}) =>
  runWithHost(pool, source, { scopes: scopes(), secretKeys: ["SHOP_API_KEY"], tables: ["orders"], ...options });

describe("globals", () => {
  test("every global of the guest API exists with the right kind (ADR-022)", async () => {
    const globals = {
      say: "function",
      fetch: "function",
      axios: "object",
      kb: "object",
      ai: "object",
      log: "object",
      ctx: "object",
      event: "object",
      turn: "object",
      workflow: "object",
      conversation: "object",
      user: "object",
      bot: "object",
      env: "object",
      tables: "object",
    };
    const names = JSON.stringify(Object.keys(globals));
    const { outcome } = await run(`return ${names}.map((n) => typeof globalThis[n]);`);
    expect(resultOf(outcome).value).toEqual(Object.values(globals));
  });

  test("the methods of each namespace are functions", async () => {
    const { outcome } = await run(`return {
      axios: ["get", "delete", "post", "put", "patch"].map((m) => typeof axios[m]),
      kb: typeof kb.search,
      ai: ["generate", "extract", "classify"].map((m) => typeof ai[m]),
      log: ["info", "warn", "error"].map((m) => typeof log[m]),
      table: ["find", "get", "insert", "update", "upsert", "delete"].map((m) => typeof tables.orders[m]),
    };`);
    const f = "function";
    expect(resultOf(outcome).value).toEqual({
      axios: [f, f, f, f, f],
      kb: f,
      ai: [f, f, f],
      log: [f, f, f],
      table: [f, f, f, f, f, f],
    });
  });

  test("the bridge itself is not reachable from the code", async () => {
    const { outcome } = await run(
      "return Object.getOwnPropertyNames(globalThis).filter((n) => n.startsWith('__') || /host|bridge/i.test(n));",
    );
    expect(resultOf(outcome).value).toEqual([]);
  });

  test("still no require, process, timers or modules", async () => {
    const names = ["require", "process", "module", "setTimeout", "setInterval", "queueMicrotask", "WebAssembly"];
    const { outcome } = await run(`return ${JSON.stringify(names)}.map((n) => typeof globalThis[n]);`);
    expect(resultOf(outcome).value).toEqual(names.map(() => "undefined"));
  });
});

describe("scopes", () => {
  test("every scope is readable, Arabic intact", async () => {
    const { outcome } = await run(
      "return [workflow.orderNumber, conversation.language, user.plan, user.attributes.tier, bot.storeName, event.text, env.SHOP_URL];",
    );
    expect(resultOf(outcome).value).toEqual([
      "١٢٣",
      "ar",
      "free",
      "gold",
      "النور",
      "وين طلبي؟ where is my order",
      "https://shop.example",
    ]);
  });

  test("writes come back as patches, one top-level variable at a time", async () => {
    const { outcome } = await run(`
      workflow.attempts += 1;
      workflow.status = "تم الشحن";
      conversation.cart.items.push({ sku: "B2", qty: 2 });
      delete conversation.language;
      user.plan = "pro";
      turn.seen = true;`);
    expect(resultOf(outcome).scopePatches).toEqual({
      workflow: { set: { attempts: 1, status: "تم الشحن" } },
      conversation: {
        set: {
          cart: {
            items: [
              { sku: "A1", qty: 1 },
              { sku: "B2", qty: 2 },
            ],
          },
        },
        unset: ["language"],
      },
      user: { set: { plan: "pro" } },
      turn: { set: { seen: true } },
    });
  });

  test("setting a variable to undefined unsets it", async () => {
    const { outcome } = await run("workflow.tags = undefined;");
    expect(resultOf(outcome).scopePatches).toEqual({ workflow: { unset: ["tags"] } });
  });

  test("code that writes nothing has no patches", async () => {
    const { outcome } = await run("const x = workflow.attempts + 1; return x;");
    expect(resultOf(outcome).scopePatches).toEqual({});
  });

  test("assigning an equal value is not a change", async () => {
    const { outcome } = await run("workflow.tags = ['new']; conversation.cart = { items: [{ sku: 'A1', qty: 1 }] };");
    expect(resultOf(outcome).scopePatches).toEqual({});
  });

  test.each([
    ["env", "env.SHOP_URL = 'https://evil.example';"],
    ["bot", "bot.storeName = 'x';"],
    ["event", "event.text = 'x';"],
    ["a nested part of bot", "bot.openHours.from = 0;"],
    ["user.attributes", "user.attributes.tier = 'platinum';"],
    ["user.attributes itself", "user.attributes = {};"],
  ])("%s is read-only: the write throws at its line", async (_name, write) => {
    const e = errorOf((await run(`const a = 1;\n${write}`)).outcome);
    expect(e.code).toBe("code_error");
    expect(e.line).toBe(2);
  });

  test("code that fails returns no patches", async () => {
    const { outcome } = await run("workflow.status = 'half done';\nthrow new Error('stop');");
    expect(outcome.t).toBe("error");
    expect(outcome).not.toHaveProperty("scopePatches");
  });

  test("code runs in strict mode: assigning an undeclared name throws", async () => {
    const e = errorOf((await run("undeclared = 1;")).outcome);
    expect(e.code).toBe("code_error");
    expect(e.message).toMatch(/undeclared/);
  });

  test("a value that cannot become JSON in a scope is code_error", async () => {
    const e = errorOf((await run("workflow.big = 10n;")).outcome);
    expect(e.code).toBe("code_error");
    expect(e.message).toMatch(/workflow/);
  });

  test("scopes are copies: one exec's writes never reach the next", async () => {
    await run("workflow.attempts = 99; globalThis.workflow.leak = 1;");
    const { outcome } = await run("return [workflow.attempts, workflow.leak];");
    expect(resultOf(outcome).value).toEqual([0, null]);
  });

  test("an exec without scopes sees empty objects", async () => {
    const { outcome } = await runWithHost(
      pool,
      "return [typeof workflow, Object.keys(env).length, typeof user.attributes];",
    );
    expect(resultOf(outcome).value).toEqual(["object", 0, "object"]);
  });
});

describe("ctx", () => {
  test("ctx.idempotencyKey comes from the frame and cannot change", async () => {
    const { outcome } = await run("try { ctx.idempotencyKey = 'x'; } catch {} return ctx.idempotencyKey;", {
      idempotencyKey: "step_01_key",
    });
    expect(resultOf(outcome).value).toBe("step_01_key");
  });

  test("without one, it is the exec id", async () => {
    const { outcome } = await run("return ctx.idempotencyKey;", { execId: "exec_ctx_default" });
    expect(resultOf(outcome).value).toBe("exec_ctx_default");
  });
});

describe("platform calls", () => {
  test("say sends a tool_call and waits for its answer", async () => {
    const r = await run("await say('أهلاً'); await say({ type: 'image', url: 'https://x/a.png' }); return 'sent';", {
      handlers: { say: () => null },
    });
    expect(resultOf(r.outcome).value).toBe("sent");
    expect(r.calls.map((c) => [c.name, c.input])).toEqual([
      ["say", { message: { type: "text", text: "أهلاً" } }],
      ["say", { message: { type: "image", url: "https://x/a.png" } }],
    ]);
  });

  test("tables calls carry the table name and their arguments", async () => {
    const r = await run(
      `const rows = await tables.orders.find({ where: { status: { eq: "placed" } }, limit: 5 });
       const one = await tables.orders.get({ number: { eq: "١٢٣" } });
       const added = await tables.orders.insert({ number: "9", status: "placed" });
       const changed = await tables.orders.update({ number: { eq: "9" } }, { status: "shipped" });
       const up = await tables.orders.upsert({ number: "9", status: "delivered" }, "number");
       const gone = await tables.orders.delete({ number: { eq: "9" } });
       return { rows, one, added, changed, up, gone };`,
      {
        handlers: {
          "tables.find": () => [{ id: "row_1", number: "١٢٣" }],
          "tables.get": () => ({ id: "row_1", number: "١٢٣" }),
          "tables.insert": () => ({ id: "row_2", number: "9" }),
          "tables.update": () => 1,
          "tables.upsert": () => ({ id: "row_2", number: "9" }),
          "tables.delete": () => 1,
        },
      },
    );
    expect(resultOf(r.outcome).value).toEqual({
      rows: [{ id: "row_1", number: "١٢٣" }],
      one: { id: "row_1", number: "١٢٣" },
      added: { id: "row_2", number: "9" },
      changed: 1,
      up: { id: "row_2", number: "9" },
      gone: 1,
    });
    expect(r.calls.map((c) => [c.name, c.input])).toEqual([
      ["tables.find", { table: "orders", where: { status: { eq: "placed" } }, limit: 5 }],
      ["tables.get", { table: "orders", where: { number: { eq: "١٢٣" } } }],
      ["tables.insert", { table: "orders", values: { number: "9", status: "placed" } }],
      ["tables.update", { table: "orders", where: { number: { eq: "9" } }, values: { status: "shipped" } }],
      ["tables.upsert", { table: "orders", values: { number: "9", status: "delivered" }, on: "number" }],
      ["tables.delete", { table: "orders", where: { number: { eq: "9" } } }],
    ]);
  });

  test("only the tables named in the frame exist", async () => {
    const { outcome } = await run("return [Object.keys(tables), typeof tables.customers, typeof tables.orders];");
    expect(resultOf(outcome).value).toEqual([["orders"], "undefined", "object"]);
  });

  test("kb.search and ai calls send their options", async () => {
    const r = await run(
      `const hits = await kb.search("سياسة الإرجاع", { topK: 3 });
       const text = await ai.generate({ instructions: "Summarise", input: "نص" });
       const data = await ai.extract({ input: "order 9", schema: { type: "object" } });
       const label = await ai.classify({ input: "refund please", labels: ["refund", "other"] });
       return [hits.length, text, data, label];`,
      {
        handlers: {
          "kb.search": () => [{ chunkId: "c1", text: "١٤ يوم", cite: "[[c1]]" }],
          "ai.generate": () => "ملخص",
          "ai.extract": () => ({ order: 9 }),
          "ai.classify": () => "refund",
        },
      },
    );
    expect(resultOf(r.outcome).value).toEqual([1, "ملخص", { order: 9 }, "refund"]);
    expect(r.calls.map((c) => [c.name, c.input])).toEqual([
      ["kb.search", { query: "سياسة الإرجاع", topK: 3 }],
      ["ai.generate", { instructions: "Summarise", input: "نص" }],
      ["ai.extract", { input: "order 9", schema: { type: "object" } }],
      ["ai.classify", { input: "refund please", labels: ["refund", "other"] }],
    ]);
  });

  test("a failed call rejects with an Error carrying its code", async () => {
    const r = await run(
      "try { await tables.orders.insert({}); } catch (e) { return [e instanceof Error, e.code, e.message]; }",
      {
        handlers: {
          "tables.insert": () => {
            throw new ToolError("table_row_invalid", "number is required");
          },
        },
      },
    );
    expect(resultOf(r.outcome).value).toEqual([true, "table_row_invalid", "number is required"]);
  });

  test("an uncaught failed call is code_error at the line of the call", async () => {
    const r = await run("const a = 1;\nconst b = 2;\nawait tables.orders.get({});", {
      handlers: {
        "tables.get": () => {
          throw new ToolError("tool_failed", "the table is unavailable");
        },
      },
    });
    const e = errorOf(r.outcome);
    expect(e).toMatchObject({ code: "code_error", message: "the table is unavailable", line: 3 });
  });

  test("calls run concurrently; more than 16 at once wait their turn", async () => {
    let inFlight = 0;
    let most = 0;
    const r = await run(
      "const all = await Promise.all(Array.from({ length: 40 }, (_, i) => kb.search('q' + i))); return all.length;",
      {
        handlers: {
          "kb.search": async () => {
            inFlight++;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight--;
            return [];
          },
        },
      },
    );
    expect(resultOf(r.outcome).value).toBe(40);
    expect(most).toBeLessThanOrEqual(16);
    expect(most).toBeGreaterThan(1);
  });

  test("past 500 calls in one exec, further calls reject", async () => {
    const r = await run(
      "let ok = 0; for (let i = 0; i < 501; i++) { try { await say('x'); ok++; } catch (e) { return [ok, e.code]; } } return [ok];",
      { handlers: { say: () => null }, timeoutMs: 20_000 },
    );
    expect(resultOf(r.outcome).value).toEqual([500, "code_error"]);
    expect(r.calls).toHaveLength(500);
  });

  test("a pending call keeps the exec alive until its answer", async () => {
    const r = await run("return await ai.generate({ instructions: 'x' });", {
      handlers: { "ai.generate": () => new Promise((resolve) => setTimeout(() => resolve("late"), 50)) },
    });
    expect(resultOf(r.outcome).value).toBe("late");
  });

  test("a call that is never answered ends at the deadline, without a hard kill", async () => {
    const kills = pool.health().kills;
    const r = await run("await say('hello');", { answer: false, timeoutMs: 200 });
    expect(errorOf(r.outcome).code).toBe("code_timeout");
    expect(pool.health().kills).toBe(kills);
  });

  test("an answer for an unknown call is ignored", async () => {
    const execId = "exec_unknown_answer";
    const pending = runWithHost(pool, "return await ai.generate({ instructions: 'x' });", {
      execId,
      handlers: {
        "ai.generate": () => {
          pool.deliver(execId, { t: "tool_result", callId: "call_forged", ok: true, value: "forged" });
          return "real";
        },
      },
    });
    expect(resultOf((await pending).outcome).value).toBe("real");
  });
});

describe("log", () => {
  test("log lines are frames with their level and JSON arguments", async () => {
    const r = await run("log.info('بدأ', { n: 1 }); log.warn('w'); log.error('e', [1, 2]); return 1;");
    expect(r.logs).toEqual([
      { t: "log", level: "info", args: ["بدأ", { n: 1 }] },
      { t: "log", level: "warn", args: ["w"] },
      { t: "log", level: "error", args: ["e", [1, 2]] },
    ]);
  });

  test("log is synchronous and keeps its order with platform calls", async () => {
    const r = await run("const x = log.info('a'); await say('b'); log.info('c'); return typeof x;", {
      handlers: { say: () => null },
    });
    expect(resultOf(r.outcome).value).toBe("undefined");
    expect(r.frames.map((f) => (f.t === "log" ? f.args[0] : f.name))).toEqual(["a", "say", "c"]);
  });

  test("values that are not JSON are logged as text", async () => {
    const r = await run("log.info(undefined, 10n, Symbol('s')); return 1;");
    expect(r.logs[0]?.args).toEqual(["undefined", "10", "Symbol(s)"]);
  });

  test("secret env values are redacted in log lines", async () => {
    const r = await run(
      "log.info('key ' + env.SHOP_API_KEY, { k: env.SHOP_API_KEY, url: env.SHOP_URL }, [env.SHOP_API_KEY]); return 1;",
    );
    expect(r.logs[0]?.args).toEqual([
      "key [redacted]",
      { k: "[redacted]", url: "https://shop.example" },
      ["[redacted]"],
    ]);
    expect(JSON.stringify(r.frames)).not.toContain("sk-live-9f8e7d6c5b4a");
  });

  test("secret env values are redacted in error messages", async () => {
    const e = errorOf((await run("throw new Error('auth failed for ' + env.SHOP_API_KEY);")).outcome);
    expect(e.message).toBe("auth failed for [redacted]");
  });

  test("secret values shorter than 4 characters are not redacted", async () => {
    const r = await run("log.info('pin ' + env.PIN); return 1;", {
      scopes: { env: { PIN: "123" } },
      secretKeys: ["PIN"],
    });
    expect(r.logs[0]?.args).toEqual(["pin 123"]);
  });

  test("after 200 lines the rest are dropped and counted", async () => {
    const r = await run("for (let i = 0; i < 205; i++) log.info(i); return 1;");
    expect(r.logs).toHaveLength(201);
    expect(r.logs[199]?.args).toEqual([199]);
    expect(r.logs[200]).toEqual({ t: "log", level: "warn", args: ["5 log lines were dropped"] });
  });

  test("a line longer than 8 KB is cut", async () => {
    const r = await run("log.info('ب'.repeat(20000)); return 1;");
    const text = JSON.stringify(r.logs[0]?.args);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024 + 16);
    expect(text).toContain("…");
  });
});

describe("line numbers", () => {
  test("an error after an await reports its line", async () => {
    const e = errorOf((await run("await null;\nconst a = 1;\nnull.x;")).outcome);
    expect(e).toMatchObject({ code: "code_error", line: 3 });
  });

  test("an error inside a function reports the innermost line in the code", async () => {
    const e = errorOf((await run("function f() {\n  return missing();\n}\nawait null;\nf();")).outcome);
    expect(e).toMatchObject({ code: "code_error", line: 2 });
  });
});
