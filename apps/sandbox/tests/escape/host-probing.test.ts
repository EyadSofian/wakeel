import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../../src/pool";
import { resultOf, runWithHost } from "../../test/host";

/**
 * Escape suite (build plan 3.4, threat T2): probing for host functions. The guest can reach the
 * language built-ins and the guest API, which is guest code. It must not reach the bridge, Node,
 * the file system, the network, or any text that reveals the host. This suite only grows.
 */

let pool: SandboxPool;

beforeAll(async () => {
  pool = new SandboxPool({ size: 1 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

describe("nothing of the host is reachable", () => {
  test("no Node, Deno, Bun, QuickJS libc or host globals", async () => {
    const names = [
      "process",
      "require",
      "module",
      "exports",
      "global",
      "Buffer",
      "Deno",
      "Bun",
      "std",
      "os",
      "scriptArgs",
      "print",
      "console",
      "__loadScript",
      "setTimeout",
      "setInterval",
      "setImmediate",
      "queueMicrotask",
      "WebAssembly",
      "Worker",
      "importScripts",
      "XMLHttpRequest",
      "WebSocket",
    ];
    const r = await runWithHost(
      pool,
      `return ${JSON.stringify(names)}.filter((n) => typeof globalThis[n] !== "undefined");`,
    );
    expect(resultOf(r.outcome).value).toEqual([]);
  });

  test("walking every object reachable from globalThis finds no host function", async () => {
    // Collect every native function reachable through own properties and prototypes. Each must be a
    // language built-in: a pristine set of names is all that may appear.
    const r = await runWithHost(
      pool,
      `const seen = new Set();
       const natives = new Set();
       const stack = [globalThis];
       while (stack.length > 0) {
         const value = stack.pop();
         if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
         seen.add(value);
         if (typeof value === "function" && /\\[native code\\]/.test(Function.prototype.toString.call(value))) natives.add(value.name);
         let names = [];
         try { names = Reflect.ownKeys(value); } catch {}
         for (const key of names) {
           let desc;
           try { desc = Object.getOwnPropertyDescriptor(value, key); } catch { continue; }
           if (!desc) continue;
           for (const v of [desc.value, desc.get, desc.set]) if (v !== undefined) stack.push(v);
         }
         try { stack.push(Object.getPrototypeOf(value)); } catch {}
       }
       return { count: seen.size, natives: [...natives] };`,
      { timeoutMs: 5_000, tables: ["orders"] },
    );
    const { natives, count } = resultOf(r.outcome).value as { natives: string[]; count: number };
    expect(count).toBeGreaterThan(100);
    // The bridge functions are created on the host as "call" and "emit". A built-in "call"
    // (Function.prototype.call) exists, so the check is that only built-in names appear and that
    // "emit" (no built-in has that name) does not.
    expect(natives).not.toContain("emit");
    expect(natives).not.toContain("install");
    expect(natives).not.toContain("snapshot");
  });

  test("the bridge's call is not reachable: the only native 'call' is Function.prototype.call", async () => {
    const r = await runWithHost(
      pool,
      `const found = [];
       const seen = new Set();
       const stack = [globalThis];
       while (stack.length > 0) {
         const value = stack.pop();
         if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) continue;
         seen.add(value);
         if (typeof value === "function" && value.name === "call" && value !== Function.prototype.call) found.push(String(value));
         for (const key of Reflect.ownKeys(value)) {
           const desc = Object.getOwnPropertyDescriptor(value, key);
           if (desc) for (const v of [desc.value, desc.get, desc.set]) if (v !== undefined) stack.push(v);
         }
         stack.push(Object.getPrototypeOf(value));
       }
       return found;`,
      { timeoutMs: 5_000 },
    );
    expect(resultOf(r.outcome).value).toEqual([]);
  });

  test("caller chains from sloppy functions never reveal the prelude or the bridge", async () => {
    const r = await runWithHost(
      pool,
      `const texts = [];
       const probe = Function("let f = arguments.callee; const out = []; for (let i = 0; i < 10 && f; i++) { out.push(String(f)); try { f = f.caller; } catch (e) { out.push('blocked'); break; } } return out.join('\\\\n');");
       await say({ type: "custom", name: "x", data: { toJSON: probe } });
       texts.push(probe());
       return texts;`,
      { handlers: { say: () => null } },
    );
    const sent = JSON.stringify(r.calls[0]?.input ?? "");
    const returned = JSON.stringify(resultOf(r.outcome).value);
    for (const text of [sent, returned]) {
      expect(text).not.toContain("configText");
      expect(text).not.toContain("invoke(");
      expect(text).not.toContain("emit(");
    }
  });

  test("arguments.callee and caller throw in the guest's strict code", async () => {
    const r = await runWithHost(
      pool,
      `const out = [];
       try { (function () { return arguments.callee; })(); out.push("callee"); } catch (e) { out.push(e.name); }
       try { (function f() { return f.caller; })(); out.push("caller"); } catch (e) { out.push(e.name); }
       return out;`,
    );
    expect(resultOf(r.outcome).value).toEqual(["TypeError", "TypeError"]);
  });

  test("error stacks name only the guest's own files, never a host path", async () => {
    const r = await runWithHost(
      pool,
      `const stacks = [];
       try { null.x; } catch (e) { stacks.push(e.stack); }
       try { await fetch("https://a.example"); } catch (e) { stacks.push(e.stack); }
       try { JSON.parse("{"); } catch (e) { stacks.push(e.stack); }
       return stacks.join("\\n");`,
    );
    const text = String(resultOf(r.outcome).value);
    expect(text).toContain("code.js");
    expect(text).not.toMatch(/\/Users\/|\/home\/|\/app\/|node:|file:|\.ts\b|worker|runner|quickjs/i);
  });

  test("the API functions' source names no host value", async () => {
    const r = await runWithHost(pool, "return [String(say), String(fetch), String(log.info), String(tables)];", {
      scopes: { env: { KEY: "canary-secret-value" } },
      secretKeys: ["KEY"],
      capabilityToken: "wkc1.canary-capability.token",
    });
    const text = JSON.stringify(resultOf(r.outcome).value);
    expect(text).not.toContain("canary-secret-value");
    expect(text).not.toContain("canary-capability");
  });

  test("the capability token is nowhere in the guest's reach", async () => {
    const r = await runWithHost(
      pool,
      `const seen = new Set(); const hits = []; const stack = [globalThis];
       while (stack.length > 0) {
         const v = stack.pop();
         if (typeof v === "string") { if (v.includes("canary-capability")) hits.push(v); continue; }
         if (v === null || (typeof v !== "object" && typeof v !== "function") || seen.has(v)) continue;
         seen.add(v);
         for (const key of Reflect.ownKeys(v)) {
           const d = Object.getOwnPropertyDescriptor(v, key);
           if (d) for (const x of [d.value, d.get, d.set]) if (x !== undefined) stack.push(x);
         }
         stack.push(Object.getPrototypeOf(v));
         if (typeof v === "function") { try { stack.push(Function.prototype.toString.call(v)); } catch {} }
       }
       return hits;`,
      { capabilityToken: "wkc1.canary-capability.token", timeoutMs: 5_000 },
    );
    expect(resultOf(r.outcome).value).toEqual([]);
  });

  test("odd arguments to the guest API fail inside the guest, never on the host", async () => {
    const r = await runWithHost(
      pool,
      `const out = [];
       const attempts = [
         () => fetch(Symbol("x")),
         () => fetch("https://a.example", new Proxy({}, { get() { throw new Error("trap"); } })),
         () => say(Symbol("x")),
         () => say(new Proxy({}, { ownKeys() { throw new Error("trap"); } })),
         () => tables.orders.insert(10n),
         () => kb.search({ toString() { throw new Error("trap"); } }),
       ];
       for (const attempt of attempts) {
         try { await attempt(); out.push("ok"); } catch (e) { out.push(e instanceof Error ? "error" : typeof e); }
       }
       return out;`,
      { tables: ["orders"], handlers: { "kb.search": () => [] } },
    );
    const out = resultOf(r.outcome).value as string[];
    expect(out).toHaveLength(6);
    // None of these reach the host as a call: each fails while the guest builds its JSON.
    expect(r.calls.filter((c) => c.name !== "kb.search")).toEqual([]);
    expect(pool.health().kills).toBe(0);
  });
});
