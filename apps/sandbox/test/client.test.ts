import type { AddressInfo } from "node:net";
import { AppError } from "@wakeel/contracts";
import { createExpressionPort, createSandboxClient, type SandboxClient } from "@wakeel/sandbox-client";
import { createLogger } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { createSandboxServer, type SandboxServer } from "../src/server";

/**
 * `packages/sandbox-client` against the real service (ADR-019 §10, ADR-023): the worker's way in.
 * Tool calls travel back over the same NDJSON stream and are answered by the handler.
 */

let pool: SandboxPool;
let server: SandboxServer;
let client: SandboxClient;

beforeAll(async () => {
  pool = new SandboxPool({ size: 2 });
  await pool.start();
  server = createSandboxServer({
    pool,
    logger: createLogger({ service: "sandbox", level: "silent" }),
    requestFrameBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  client = createSandboxClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
});

afterAll(async () => {
  await server?.close();
  await pool?.close();
});

let n = 0;
const execId = () => `exec_client_${++n}`;

describe("exec", () => {
  test("returns the result frame with scope patches", async () => {
    const outcome = await client.exec(
      { execId: execId(), kind: "code", source: "workflow.n += 1; return 'تم';", scopes: { workflow: { n: 1 } } },
      { onToolCall: () => Promise.resolve(null) },
    );
    expect(outcome).toMatchObject({ t: "result", value: "تم", scopePatches: { workflow: { set: { n: 2 } } } });
  });

  test("answers tool calls over the same stream", async () => {
    const seen: [string, unknown][] = [];
    const outcome = await client.exec(
      {
        execId: execId(),
        kind: "code",
        source: "const rows = await tables.orders.find({ limit: 1 }); await say('وجدت ' + rows.length); return rows;",
        tables: ["orders"],
      },
      {
        onToolCall: async ({ name, input }) => {
          seen.push([name, input]);
          return name === "tables.find" ? [{ id: "row_1" }] : null;
        },
      },
    );
    expect(outcome).toMatchObject({ t: "result", value: [{ id: "row_1" }] });
    expect(seen).toEqual([
      ["tables.find", { table: "orders", limit: 1 }],
      ["say", { message: { type: "text", text: "وجدت 1" } }],
    ]);
  });

  test("an AppError from the handler reaches the guest as its code and title", async () => {
    const outcome = await client.exec(
      {
        execId: execId(),
        kind: "code",
        source: "try { await tables.orders.get({}); } catch (e) { return [e.code, e.message]; }",
        tables: ["orders"],
      },
      {
        onToolCall: () =>
          Promise.reject(new AppError("tool_failed", { tool: "tables.get", message: "the table is unavailable" })),
      },
    );
    expect(outcome).toMatchObject({
      t: "result",
      value: ["tool_failed", '"tables.get" failed: the table is unavailable'],
    });
  });

  test("any other handler failure reaches the guest without its details", async () => {
    const outcome = await client.exec(
      { execId: execId(), kind: "code", source: "try { await say('x'); } catch (e) { return [e.code, e.message]; }" },
      { onToolCall: () => Promise.reject(new Error("db password is hunter2")) },
    );
    expect(outcome).toMatchObject({ t: "result", value: ["internal_error", "the call failed"] });
  });

  test("log frames reach onLog", async () => {
    const logs: unknown[] = [];
    await client.exec(
      { execId: execId(), kind: "code", source: "log.info('a', 1); log.error('b');" },
      { onToolCall: () => Promise.resolve(null), onLog: (frame) => logs.push(frame) },
    );
    expect(logs).toEqual([
      { t: "log", level: "info", args: ["a", 1] },
      { t: "log", level: "error", args: ["b"] },
    ]);
  });

  test("a refused request rejects with the problem's AppError", async () => {
    await expect(
      client.exec(
        { execId: execId(), kind: "code", source: "1", limits: { timeoutMs: 1_000_000 } },
        { onToolCall: () => Promise.resolve(null) },
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  test("aborting the signal cancels the exec", async () => {
    const controller = new AbortController();
    const running = client.exec(
      { execId: execId(), kind: "code", source: "for (;;) {}", limits: { timeoutMs: 30_000 } },
      { onToolCall: () => Promise.resolve(null), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toThrow();
    await pool.whenReady();
    expect(pool.health().busy).toBe(0);
  });

  test("an unreachable sandbox rejects with internal_error", async () => {
    const offline = createSandboxClient({ url: "http://127.0.0.1:1" });
    await expect(
      offline.exec({ execId: execId(), kind: "code", source: "1" }, { onToolCall: () => Promise.resolve(null) }),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});

describe("expression port (ADR-018)", () => {
  test("evaluates a batch into outcomes; undefined has no value", async () => {
    const port = createExpressionPort(client);
    const outcomes = await port.evalExpressions({
      expressions: ["workflow.a + 1", "nope()", "undefined", "'مرحبا ' + user.name"],
      scopes: { workflow: { a: 1 }, user: { name: "منى" } },
    });
    expect(outcomes[0]).toEqual({ ok: true, value: 2 });
    expect(outcomes[1]).toMatchObject({ ok: false });
    expect(outcomes[2]).toEqual({ ok: true, value: undefined });
    expect("value" in (outcomes[2] ?? {})).toBe(true);
    expect(outcomes[3]).toEqual({ ok: true, value: "مرحبا منى" });
  });

  test("a whole-batch failure rejects the port call", async () => {
    const port = createExpressionPort(client, { timeoutMs: 100 });
    await expect(
      port.evalExpressions({ expressions: ["(() => { for (;;) {} })()"], scopes: {} }),
    ).rejects.toMatchObject({ code: "code_timeout" });
  });
});
