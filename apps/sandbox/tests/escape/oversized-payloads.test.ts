import type { AddressInfo } from "node:net";
import { SANDBOX_LIMITS } from "@wakeel/config";
import { createLogger } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../../src/pool";
import { createSandboxServer, type SandboxServer } from "../../src/server";
import { errorOf, resultOf, runWithHost } from "../../test/host";

/**
 * Escape suite (build plan 3.4, threats T2 and T8): oversized payloads in every direction. A payload
 * that is too large ends with a code or is refused at the edge; it never takes the service down,
 * never holds a runner past its deadline and never needs a hard kill. This suite only grows.
 */

let pool: SandboxPool;
let server: SandboxServer;
let base: string;

beforeAll(async () => {
  pool = new SandboxPool({ size: 1 });
  await pool.start();
  server = createSandboxServer({
    pool,
    logger: createLogger({ service: "sandbox", level: "silent" }),
    requestFrameBytes: SANDBOX_LIMITS.requestFrameBytes,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server?.close();
  await pool?.close();
});

const stillServing = async () => {
  const r = await runWithHost(pool, "return 'ok';");
  expect(resultOf(r.outcome).value).toBe("ok");
};

const MB = 1024 * 1024;

describe("from the guest", () => {
  test("a call input over 4 MB is refused in the guest, never sent", async () => {
    const r = await runWithHost(
      pool,
      "try { await say('x'.repeat(5 * 1024 * 1024)); } catch (e) { return [e.code, e.message]; }",
      { handlers: { say: () => null } },
    );
    expect(resultOf(r.outcome).value).toEqual(["code_error", "the input of say is larger than 4 MB"]);
    expect(r.calls).toEqual([]);
  });

  test("a fetch body over 4 MB is refused before egress", async () => {
    const r = await runWithHost(
      pool,
      "try { await fetch('https://a.example', { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024) }); } catch (e) { return e.code; }",
      { capabilityToken: "wkc1.x.y" },
    );
    expect(resultOf(r.outcome).value).toBe("code_error");
  });

  test("a 1 MB log line is cut to 8 KB", async () => {
    const r = await runWithHost(pool, "log.info('ع'.repeat(1024 * 1024)); return 1;");
    expect(Buffer.byteLength(JSON.stringify(r.logs[0]?.args), "utf8")).toBeLessThanOrEqual(8 * 1024 + 16);
  });

  test("a result larger than the heap can encode ends with code_memory_exceeded", async () => {
    const e = errorOf((await runWithHost(pool, "return 'x'.repeat(40 * 1024 * 1024);", { timeoutMs: 20_000 })).outcome);
    expect(e.code).toBe("code_memory_exceeded");
    await stillServing();
  });

  test("a large result that fits comes back whole", async () => {
    const r = await runWithHost(pool, "return 'ب'.repeat(2 * 1024 * 1024);", { timeoutMs: 20_000 });
    expect((resultOf(r.outcome).value as string).length).toBe(2 * MB);
  });

  test("a scope patch larger than the heap can encode ends with code_memory_exceeded", async () => {
    const e = errorOf(
      (await runWithHost(pool, "workflow.big = 'x'.repeat(40 * 1024 * 1024);", { timeoutMs: 20_000 })).outcome,
    );
    expect(e.code).toBe("code_memory_exceeded");
    await stillServing();
  });
});

describe("from the host", () => {
  test("a tool result larger than the guest's memory ends with code_memory_exceeded", async () => {
    const r = await runWithHost(pool, "const t = await ai.generate({ instructions: 'x' }); return t.length;", {
      memoryMb: 8,
      timeoutMs: 10_000,
      handlers: { "ai.generate": () => "x".repeat(32 * MB) },
    });
    expect(errorOf(r.outcome).code).toBe("code_memory_exceeded");
    await stillServing();
  });

  test("a large tool result that fits arrives whole", async () => {
    const r = await runWithHost(pool, "const t = await ai.generate({ instructions: 'x' }); return t.length;", {
      timeoutMs: 10_000,
      handlers: { "ai.generate": () => "م".repeat(3 * MB) },
    });
    expect(resultOf(r.outcome).value).toBe(3 * MB);
  });

  test("scopes larger than the guest's memory end with code_memory_exceeded", async () => {
    const r = await runWithHost(pool, "return 1;", {
      memoryMb: 4,
      scopes: { workflow: { big: "x".repeat(16 * MB) } },
    });
    expect(errorOf(r.outcome).code).toBe("code_memory_exceeded");
    await stillServing();
  });

  test("deeply nested scopes fail the run, not the service", async () => {
    let nested: unknown = 1;
    for (let i = 0; i < 100_000; i++) nested = [nested];
    const r = await runWithHost(pool, "return 1;", { scopes: { workflow: { deep: nested } } }).catch(
      (error: unknown) => error,
    );
    if (r instanceof Error) expect(r.message).not.toMatch(/Maximum call stack/);
    else expect(r.outcome.t).toBe("error");
    await stillServing();
  });

  test("source code of 3 MB compiles or fails cleanly", async () => {
    const source = `const a = [${"1,".repeat(1_500_000)}]; return a.length;`;
    const r = await runWithHost(pool, source, { timeoutMs: 20_000 });
    expect(["result", "error"]).toContain(r.outcome.t);
    await stillServing();
  });
});

describe("at the HTTP edge", () => {
  const post = (body: string) =>
    fetch(`${base}/exec`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body });

  test("a request frame over 4 MB is payload_too_large", async () => {
    const frame = { execId: "exec_big", kind: "code", source: `return '${"x".repeat(5 * MB)}';` };
    const res = await post(`${JSON.stringify(frame)}\n`);
    expect(res.status).toBe(413);
    await stillServing();
  });

  test("a tool result line over 4 MB is dropped, and the exec still ends at its deadline", async () => {
    // The service cannot read a call id out of a line it refuses to hold, so the call stays
    // unanswered and the deadline ends the exec. Nothing larger than one frame is ever buffered.
    const controller = new AbortController();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ execId: "exec_big_answer", kind: "code", source: "await say('x');", limits: { timeoutMs: 1_500 } })}\n`,
          ),
        );
        c.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ t: "tool_result", callId: "call_0", ok: true, value: "x".repeat(5 * MB) })}\n`,
          ),
        );
        c.close();
      },
    });
    const res = await fetch(`${base}/exec`, {
      method: "POST",
      body,
      // @ts-expect-error Node's fetch needs duplex for a streamed body; the DOM types lack it.
      duplex: "half",
      signal: controller.signal,
    });
    const text = await res.text();
    expect(text).toContain('"code_timeout"');
    await stillServing();
  });
});
