import type { AddressInfo } from "node:net";
import { createLogger } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { createSandboxServer, type SandboxServer } from "../src/server";

/** Integration: the HTTP surface (architecture §5.1) over a real pool. */

let pool: SandboxPool;
let server: SandboxServer;
let base: string;

beforeAll(async () => {
  pool = new SandboxPool({ size: 2 });
  await pool.start();
  server = createSandboxServer({
    pool,
    logger: createLogger({ service: "sandbox", level: "silent" }),
    requestFrameBytes: 64 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server?.close();
  await pool?.close();
});

const frame = (overrides: Record<string, unknown> = {}) => ({
  execId: "exec_http_1",
  kind: "code",
  source: "return 6 * 7;",
  scopes: {},
  toolManifest: [],
  limits: { timeoutMs: 1_000 },
  ...overrides,
});

const post = (body: string) =>
  fetch(`${base}/exec`, { method: "POST", headers: { "content-type": "application/x-ndjson" }, body });

const lines = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("health", () => {
  test("live", async () => {
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("ready reports the pool", async () => {
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", pool: { ready: true, size: 2, live: 2 } });
  });

  test("ready is 503 when QuickJS cannot load", async () => {
    const broken = new SandboxPool({ size: 1, workerUrl: new URL("./fixtures/broken-worker.ts", import.meta.url) });
    await expect(broken.start()).rejects.toThrow();
    const other = createSandboxServer({
      pool: broken,
      logger: createLogger({ service: "sandbox", level: "silent" }),
      requestFrameBytes: 1024,
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/health/ready`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "unavailable", pool: { ready: false } });
    } finally {
      await other.close();
      await broken.close();
    }
  });
});

describe("POST /exec", () => {
  test("streams one result frame as NDJSON", async () => {
    const res = await post(`${JSON.stringify(frame())}\n`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const out = await lines(res);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ t: "result", value: 42, scopePatches: {} });
  });

  test("a guest failure is an error frame on a 200 stream", async () => {
    const res = await post(`${JSON.stringify(frame({ source: "for (;;) {}", limits: { timeoutMs: 100 } }))}\n`);
    expect(res.status).toBe(200);
    expect(await lines(res)).toEqual([
      { t: "error", code: "code_timeout", message: expect.stringContaining("100 ms") },
    ]);
  });

  test("the request frame may arrive without a trailing newline", async () => {
    const res = await post(JSON.stringify(frame()));
    expect((await lines(res))[0]).toMatchObject({ t: "result", value: 42 });
  });

  test("an invalid request frame is a validation_failed problem", async () => {
    const res = await post(`${JSON.stringify(frame({ limits: { timeoutMs: 120_000 } }))}\n`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const problem = (await res.json()) as { code: string; errors: { path: string }[] };
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors.map((e) => e.path)).toEqual(["limits.timeoutMs"]);
  });

  test("a memory limit above the platform maximum is refused, not raised", async () => {
    const res = await post(`${JSON.stringify(frame({ limits: { memoryMb: 1024 } }))}\n`);
    expect(res.status).toBe(400);
  });

  test("a body that is not JSON is a validation_failed problem", async () => {
    const res = await post("not json\n");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
  });

  test("an empty body is a validation_failed problem", async () => {
    const res = await post("");
    expect(res.status).toBe(400);
  });

  test("a request frame over the size limit is payload_too_large", async () => {
    const res = await post(`${JSON.stringify(frame({ source: `return '${"x".repeat(70 * 1024)}';` }))}\n`);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe("payload_too_large");
  });

  test("the capability token never comes back in a frame", async () => {
    const res = await post(`${JSON.stringify(frame({ capabilityToken: "cap_secret_value_1234567890" }))}\n`);
    expect(await res.text()).not.toContain("cap_secret_value");
  });

  test("a client that disconnects mid-exec frees the worker", async () => {
    const controller = new AbortController();
    const req = fetch(`${base}/exec`, {
      method: "POST",
      body: `${JSON.stringify(frame({ source: "for (;;) {}", limits: { timeoutMs: 30_000 } }))}\n`,
      signal: controller.signal,
    });
    const res = await req;
    expect(res.status).toBe(200);
    controller.abort();
    // Both workers must be free again well before the 30 s deadline.
    const started = Date.now();
    const outcomes = await Promise.all([post(`${JSON.stringify(frame())}\n`), post(`${JSON.stringify(frame())}\n`)]);
    for (const r of outcomes) expect((await lines(r))[0]).toMatchObject({ t: "result", value: 42 });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("other paths are not_found problems", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });
});
