import type { AddressInfo } from "node:net";
import { AppError } from "@wakeel/contracts";
import { type ExpressionBatch, evalExpressions, renderTemplates, type SandboxPort } from "@wakeel/engine";
import { createExpressionPort, createSandboxClient } from "@wakeel/sandbox-client";
import { createLogger } from "@wakeel/telemetry";
import { firstStrongDirection, RTL_FIXTURES } from "@wakeel/testing/fixtures/rtl";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { createSandboxServer, type SandboxServer } from "../src/server";

/**
 * The engine's expression layer (task 3.5, architecture §4.6) over the real sandbox: the engine's
 * `SandboxPort` is served by the sandbox-client adapter (ADR-018) talking to this service. The
 * engine's own unit tests use a fake port; this file checks the two sides agree.
 */

let pool: SandboxPool;
let server: SandboxServer;
let url: string;

beforeAll(async () => {
  pool = new SandboxPool({ size: 2 });
  await pool.start();
  server = createSandboxServer({
    pool,
    logger: createLogger({ service: "sandbox", level: "silent" }),
    requestFrameBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server?.close();
  await pool?.close();
});

/** The real adapter, typed as the engine's port, with every batch it sends recorded. */
function realPort(options: { timeoutMs?: number } = {}): { port: SandboxPort; batches: ExpressionBatch[] } {
  // Assigning to SandboxPort is the compile-time check that the adapter fits the engine's port.
  const adapter: SandboxPort = createExpressionPort(createSandboxClient({ url }), options);
  const batches: ExpressionBatch[] = [];
  return {
    batches,
    port: {
      evalExpressions: (batch) => {
        batches.push(batch);
        return adapter.evalExpressions(batch);
      },
    },
  };
}

const scopes = {
  workflow: { items: [{ sku: "ORD-2026-45123", qty: 2 }], total: 150 },
  user: { name: "منى", attributes: { plan: "pro" } },
  conversation: {},
  bot: { name: "النور" },
  event: { type: "message", text: "عايز أعرف طلبي فين" },
  env: { CURRENCY: "EGP" },
  turn: {},
};

describe("templates over the real sandbox", () => {
  test("a template of paths only renders without a sandbox call", async () => {
    const { port, batches } = realPort();
    const [text] = await renderTemplates(
      ["أهلاً {{ user.name }}، خطتك {{ user.attributes.plan }} والطلب {{ workflow.items[0].sku }}"],
      scopes,
      port,
    );
    expect(text).toBe("أهلاً منى، خطتك pro والطلب ORD-2026-45123");
    expect(batches).toHaveLength(0);
  });

  test("a card's mixed templates render with one sandbox call", async () => {
    const { port, batches } = realPort();
    const texts = await renderTemplates(
      [
        "أهلاً {{ user.name }}، المجموع {{ workflow.total * 2 }} {{ env.CURRENCY }}",
        "Items: {{ workflow.items.map((i) => i.sku + ' × ' + i.qty).join(', ') }}",
        "{{ event.text.includes('طلبي') ? 'سأبحث عن طلبك' : 'كيف أساعدك؟' }}",
      ],
      scopes,
      port,
    );
    expect(texts).toEqual(["أهلاً منى، المجموع 300 EGP", "Items: ORD-2026-45123 × 2", "سأبحث عن طلبك"]);
    expect(batches).toHaveLength(1);
    // Paths stay on the fast path; only the three computed placeholders reach the sandbox.
    expect(batches[0]?.expressions).toEqual([
      "workflow.total * 2",
      "workflow.items.map((i) => i.sku + ' × ' + i.qty).join(', ')",
      "event.text.includes('طلبي') ? 'سأبحث عن طلبك' : 'كيف أساعدك؟'",
    ]);
  });

  test.each(RTL_FIXTURES.map((f) => [f.id, f] as const))(
    "%s comes back from the sandbox unchanged",
    async (_id, fixture) => {
      const { port, batches } = realPort();
      const [text] = await renderTemplates(
        ["{{ workflow.text.slice(0) }}"],
        { workflow: { text: fixture.text } },
        port,
      );
      expect(batches).toHaveLength(1);
      expect(text).toBe(fixture.text);
      expect(firstStrongDirection(text as string)).toBe(fixture.direction);
    },
  );

  test("a placeholder that throws in the sandbox is template_error with the sandbox's message", async () => {
    const { port } = realPort();
    const error = await renderTemplates(["مرحبا {{ workflow.missing.name.toUpperCase() }}"], scopes, port).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("template_error");
    expect(appError.params).toEqual({ expression: "workflow.missing.name.toUpperCase()" });
    expect(appError.detail).toMatch(/undefined/);
    expect((appError.cause as AppError).code).toBe("expression_error");
  });
});

describe("evalExpressions over the real sandbox", () => {
  test("each expression gets its own outcome; one failure does not hide the others", async () => {
    const { port, batches } = realPort();
    const results = await evalExpressions(
      ["user.name", "workflow.total > 100", "workflow.nope()", "user.name + ' / ' + bot.name", "workflow.total > 100"],
      scopes,
      port,
    );
    expect(results[0]).toEqual({ ok: true, value: "منى" });
    expect(results[1]).toEqual({ ok: true, value: true });
    expect(results[2]).toMatchObject({ ok: false, error: { code: "expression_error" } });
    expect((results[2] as { error: AppError }).error.params).toMatchObject({ expression: "workflow.nope()" });
    expect(results[3]).toEqual({ ok: true, value: "منى / النور" });
    expect(results[4]).toEqual(results[1]);
    // One call, each distinct source once.
    expect(batches.map((b) => b.expressions)).toEqual([
      ["workflow.total > 100", "workflow.nope()", "user.name + ' / ' + bot.name"],
    ]);
  });

  test("expressions cannot write to the scopes", async () => {
    const { port } = realPort();
    const { port: watched, batches } = realPort();
    // An assignment does not parse as an expression, so it never reaches the sandbox.
    const [assigned] = await evalExpressions(["(workflow.total = 1, workflow.total)"], scopes, watched);
    expect(assigned).toMatchObject({ ok: false, error: { code: "expression_error" } });
    expect(batches).toHaveLength(0);
    // A call that writes does; ADR-018 §3: in an expression batch every scope is frozen.
    const results = await evalExpressions(["Object.assign(workflow, { total: 1 }).total"], scopes, port);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "expression_error" } });
    expect((results[0] as { error: AppError }).error.params["message"]).toMatch(/read-only|not writable|frozen/i);
    expect(scopes.workflow.total).toBe(150);
  });

  test("a batch past its deadline fails every sandboxed expression with expression_error", async () => {
    const { port } = realPort({ timeoutMs: 100 });
    const results = await evalExpressions(["(() => { for (;;) {} })()", "1 + 1", "user.name"], scopes, port);
    expect(results[0]).toMatchObject({ ok: false, error: { code: "expression_error" } });
    expect(results[1]).toMatchObject({ ok: false, error: { code: "expression_error" } });
    const cause = (results[0] as { error: AppError }).error.cause as AppError;
    expect(cause.code).toBe("code_timeout");
    // The path was resolved natively and is unaffected.
    expect(results[2]).toEqual({ ok: true, value: "منى" });
  });
});
