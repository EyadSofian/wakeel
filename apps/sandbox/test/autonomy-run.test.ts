import type { AddressInfo } from "node:net";
import { AppError, type Json } from "@wakeel/contracts";
import { createAutonomyRunPort, createSandboxClient } from "@wakeel/sandbox-client";
import { createLogger } from "@wakeel/telemetry";
import { RTL_FIXTURES } from "@wakeel/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { createSandboxServer, type SandboxServer } from "../src/server";

/**
 * `kind: "autonomy_run"` (task 6.6, ADR-032 §1): an Autonomous Node's `:::run` block. The model's code
 * sees only the node's tools on `tools`, the scopes and `memo`. Nothing else is installed: no fetch,
 * no tables, no kb, no ai, no say. Every tool call goes back to the worker.
 */

let pool: SandboxPool;
let server: SandboxServer;
let port: ReturnType<typeof createAutonomyRunPort>;

beforeAll(async () => {
  pool = new SandboxPool({ size: 2 });
  await pool.start();
  server = createSandboxServer({
    pool,
    logger: createLogger({ service: "sandbox", level: "silent" }),
    requestFrameBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = createAutonomyRunPort(
    createSandboxClient({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }),
  );
});

afterAll(async () => {
  await server?.close();
  await pool?.close();
});

const MIXED = RTL_FIXTURES.find((f) => f.id === "arabic_product_code")?.text ?? "";
const tools = [{ name: "lookupOrder" }, { name: "orders", operations: ["find" as const, "get" as const] }];
const run = (
  source: string,
  onTool: (call: { tool: string; operation?: string; input: Json }) => Promise<Json> = async () => null,
  scopes: Record<string, Json> = {},
) => port.run({ source, scopes, tools, timeoutMs: 2_000, memoryMb: 32, idempotencyKey: "turn_1:3:run", onTool });

describe("autonomy_run", () => {
  test("calls the node's tools and returns their value", async () => {
    const calls: unknown[] = [];
    const outcome = await run(
      `const order = await tools.lookupOrder({ number: "5678" });
       const rows = await tools.orders.find({ limit: 1 });
       return { status: order.status, rows: rows.length };`,
      async (call) => {
        calls.push(call);
        return call.tool === "lookupOrder" ? { status: "اتشحن" } : [{ id: "row_1" }];
      },
    );
    expect(outcome).toMatchObject({ ok: true, value: { status: "اتشحن", rows: 1 } });
    expect(calls).toEqual([
      { tool: "lookupOrder", input: { number: "5678" } },
      { tool: "orders", operation: "find", input: { limit: 1 } },
    ]);
  });

  test("variable and memo writes come back as patches, Arabic intact", async () => {
    const outcome = await run(
      `conversation.topic = ${JSON.stringify(MIXED)}; memo.step = 2; delete memo.old; turn.seen = true;`,
      undefined,
      { conversation: {}, memo: { step: 1, old: "x" }, turn: {} },
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: null,
      patches: {
        conversation: { set: { topic: MIXED } },
        memo: { set: { step: 2 }, unset: ["old"] },
        turn: { set: { seen: true } },
      },
    });
  });

  test("only the listed tools and log exist: no fetch, tables, kb, ai or say", async () => {
    const outcome = await run(
      `return [typeof fetch, typeof axios, typeof tables, typeof kb, typeof ai, typeof say, typeof log,
        Object.keys(tools), Object.keys(tools.orders), typeof tools.orders.insert];`,
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: [
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "object",
        ["lookupOrder", "orders"],
        ["find", "get"],
        "undefined",
      ],
    });
  });

  test("tools cannot be replaced or extended by the model's code", async () => {
    const outcome = await run(
      `try { tools.lookupOrder = () => 1; } catch (e) { }
       try { tools.extra = () => 1; } catch (e) { }
       return [typeof tools.extra, await tools.lookupOrder({})];`,
      async () => "real",
    );
    expect(outcome).toMatchObject({ ok: true, value: ["undefined", "real"] });
  });

  test("a tool's AppError reaches the code as its message and code, and can be caught", async () => {
    const outcome = await run(
      `try { await tools.lookupOrder({ number: 1 }); } catch (e) { return [e.code, e.message]; }`,
      () =>
        Promise.reject(new AppError("tool_input_invalid", { tool: "lookupOrder", message: "number must be a string" })),
    );
    expect(outcome).toMatchObject({
      ok: true,
      value: ["tool_input_invalid", '"lookupOrder" was called with invalid input: number must be a string'],
    });
  });

  test("an uncaught error ends the run with its line", async () => {
    const outcome = await run(`const a = 1;\nthrow new Error("ما لقيتش الطلب");`);
    expect(outcome).toMatchObject({ ok: false, code: "code_error", line: 2 });
    if (!outcome.ok) expect(outcome.message).toContain("ما لقيتش الطلب");
  });

  test("bot, event and env are read-only", async () => {
    const outcome = await run(`try { event.text = "x"; } catch (e) { return "frozen"; } return "changed";`, undefined, {
      event: { text: "hi" },
    });
    expect(outcome).toMatchObject({ ok: true, value: "frozen" });
  });
});
