import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../../src/pool";
import { errorOf, resultOf, runWithHost } from "../../test/host";

/**
 * Escape suite (build plan 3.4, threat T2): prototype pollution of bridged objects. Only JSON text
 * crosses the bridge (ADR-023 §1), so whatever the guest does to its prototypes stays in its own
 * heap, and what the host gets back is plain data. This suite only grows.
 */

let pool: SandboxPool;

beforeAll(async () => {
  pool = new SandboxPool({ size: 1 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

const hostIsClean = () => {
  const probe = {} as Record<string, unknown>;
  expect(probe["polluted"]).toBeUndefined();
  expect(probe["isAdmin"]).toBeUndefined();
  expect(Object.prototype).not.toHaveProperty("polluted");
  expect(Array.prototype).not.toHaveProperty("polluted");
};

describe("guest prototypes never reach the host", () => {
  test("polluting Object and Array prototypes leaves tool call inputs plain", async () => {
    const r = await runWithHost(
      pool,
      `Object.prototype.polluted = "yes"; Array.prototype.polluted = "yes";
       await say({ type: "text", text: "hi" });
       return [({}).polluted, [].polluted];`,
      { handlers: { say: () => null } },
    );
    expect(resultOf(r.outcome).value).toEqual(["yes", "yes"]);
    expect(r.calls[0]?.input).toEqual({ message: { type: "text", text: "hi" } });
    expect(Object.hasOwn(r.calls[0]?.input as object, "polluted")).toBe(false);
    hostIsClean();
  });

  test("a polluted toJSON changes only the guest's own text", async () => {
    const r = await runWithHost(
      pool,
      `Object.prototype.toJSON = function () { return { hijacked: true }; };
       await say("plain text");
       return 1;`,
      { handlers: { say: () => null } },
    );
    // Whatever the guest serialises is only data; the host parses it as JSON and nothing more.
    expect(r.calls).toHaveLength(1);
    expect(typeof r.calls[0]?.input).toBe("object");
    hostIsClean();
  });

  test("__proto__ in a tool result is an own key in the guest, not a prototype", async () => {
    const r = await runWithHost(
      pool,
      `const row = await tables.users.get({});
       return [({}).isAdmin === undefined, Object.keys(row).includes("__proto__"), row.isAdmin === undefined];`,
      {
        tables: ["users"],
        handlers: { "tables.get": () => JSON.parse('{"__proto__": {"isAdmin": true}, "name": "x"}') },
      },
    );
    expect(resultOf(r.outcome).value).toEqual([true, true, true]);
    hostIsClean();
  });

  test("__proto__ in the scopes the worker sends is an own key, not a prototype", async () => {
    const r = await runWithHost(pool, "return [({}).isAdmin === undefined, workflow.isAdmin === undefined];", {
      scopes: JSON.parse('{"workflow": {"__proto__": {"isAdmin": true}}, "env": {"__proto__": {"isAdmin": true}}}'),
    });
    expect(resultOf(r.outcome).value).toEqual([true, true]);
    hostIsClean();
  });

  test("a variable named __proto__ cannot be written back to the host", async () => {
    const r = await runWithHost(
      pool,
      `Object.defineProperty(workflow, "__proto__", { value: { isAdmin: true }, enumerable: true, configurable: true, writable: true });
       return 1;`,
    );
    const e = errorOf(r.outcome);
    expect(e.code).toBe("code_error");
    expect(r.outcome).not.toHaveProperty("scopePatches");
    hostIsClean();
  });

  test.each([["constructor"], ["prototype"]])("a variable named %s cannot be written back", async (name) => {
    const r = await runWithHost(pool, `workflow[${JSON.stringify(name)}] = { isAdmin: true }; return 1;`);
    expect(errorOf(r.outcome).code).toBe("code_error");
  });

  test("setting workflow.__proto__ changes the guest object's prototype only, and writes nothing", async () => {
    const r = await runWithHost(pool, "workflow.__proto__ = { isAdmin: true }; return workflow.isAdmin;");
    expect(resultOf(r.outcome)).toMatchObject({ value: true, scopePatches: {} });
    hostIsClean();
  });

  test("polluting prototypes cannot change the result's shape on the host", async () => {
    const r = await runWithHost(
      pool,
      `Object.prototype.t = "error"; Object.prototype.code = "internal_error";
       return { ok: 1 };`,
    );
    expect(resultOf(r.outcome).value).toEqual({ ok: 1 });
    hostIsClean();
  });

  test("a later exec sees clean prototypes", async () => {
    await runWithHost(pool, "Object.prototype.polluted = 1; Array.prototype.map = null; JSON.parse = null;");
    const r = await runWithHost(pool, "return [({}).polluted, [1].map((x) => x + 1), JSON.parse('2')];");
    expect(resultOf(r.outcome).value).toEqual([null, [2], 2]);
  });

  test("replacing the built-ins the guest API uses breaks only the guest's own calls", async () => {
    const r = await runWithHost(
      pool,
      `JSON.stringify = () => '{"message":{"type":"text","text":"forged"}}';
       Promise.prototype.then = function () { return this; };
       try { await say("real"); } catch {}
       return 1;`,
      { handlers: { say: () => null } },
    );
    // The prelude captured its intrinsics before the code ran: the host got the real text.
    expect(r.calls[0]?.input).toEqual({ message: { type: "text", text: "real" } });
    expect(r.outcome.t).toBeDefined();
    hostIsClean();
  });
});
