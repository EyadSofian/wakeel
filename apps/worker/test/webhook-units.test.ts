import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RETRY_SCHEDULE_SECONDS } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { egressSender, retryAt } from "../src/webhook/index";

/** Task 5.2: the retry schedule (architecture §9.2) and the sender's egress wire format (ADR-020, ADR-028 §7). */

const T0 = new Date("2026-11-14T10:00:00.000Z");

describe("retryAt", () => {
  test.each(RETRY_SCHEDULE_SECONDS.map((s, i) => [i + 1, s] as const))(
    "after failed attempt %i the next is due %is later, ±20%",
    (attempt, seconds) => {
      const low = retryAt(attempt, T0, () => 0);
      const mid = retryAt(attempt, T0, () => 0.5);
      const high = retryAt(attempt, T0, () => 0.999_999);
      expect(mid?.getTime()).toBe(T0.getTime() + seconds * 1000);
      expect(low?.getTime()).toBe(T0.getTime() + seconds * 800);
      expect((high?.getTime() ?? 0) - T0.getTime()).toBeLessThanOrEqual(seconds * 1200);
      expect((high?.getTime() ?? 0) - T0.getTime()).toBeGreaterThan(seconds * 1199);
    },
  );

  test("after the 9th failed attempt there is none: the event is dead", () => {
    expect(RETRY_SCHEDULE_SECONDS).toHaveLength(8);
    expect(retryAt(9, T0, () => 0.5)).toBeUndefined();
    expect(retryAt(12, T0, () => 0.5)).toBeUndefined();
  });
});

describe("egressSender", () => {
  let server: Server;
  let base: string;
  const seen: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  let answer: (body: Record<string, unknown>) => { status: number; json: unknown };

  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
      });
      req.on("end", () => resolve(data));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = JSON.parse(await read(req)) as Record<string, unknown>;
      seen.push({ auth: req.headers.authorization, body });
      const { status, json } = answer(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const ok = (status: number) => ({
    status: 200,
    json: { status, statusText: "", headers: [], body: "", url: "https://r.example.test/hook", redirected: false },
  });
  const send = () =>
    egressSender({ egressUrl: base, egressToken: "t".repeat(40) }).send({
      workspaceId: "ws_01jcqz1a2b3c4d5e6f7g8h9jkm",
      url: "https://r.example.test/hook",
      headers: { "X-Wakeel-Event-Id": "evt_x" },
      body: '{"a":1}',
    });

  test("posts one fetch to egress: bearer token, workspace, POST, no redirects, 10 s", async () => {
    answer = () => ok(204);
    expect(await send()).toEqual({ kind: "response", status: 204 });
    expect(seen.at(-1)).toEqual({
      auth: `Bearer ${"t".repeat(40)}`,
      body: {
        workspaceId: "ws_01jcqz1a2b3c4d5e6f7g8h9jkm",
        url: "https://r.example.test/hook",
        method: "POST",
        headers: { "X-Wakeel-Event-Id": "evt_x" },
        body: '{"a":1}',
        redirect: "manual",
        timeoutMs: 10_000,
      },
    });
  });

  test("an upstream error status is a response, not a refusal", async () => {
    answer = () => ok(503);
    expect(await send()).toEqual({ kind: "response", status: 503 });
  });

  test.each(["fetch_blocked", "fetch_failed", "rate_limited"])(
    "egress refusing with %s is a refusal with that code",
    async (code) => {
      answer = () => ({ status: 403, json: { code, title: "x", detail: "the address is private" } });
      expect(await send()).toEqual({ kind: "refused", code, detail: "the address is private" });
    },
  );

  test("any other egress problem is fetch_failed", async () => {
    answer = () => ({ status: 400, json: { code: "validation_failed", title: "x" } });
    expect(await send()).toMatchObject({ kind: "refused", code: "fetch_failed" });
  });

  test("egress not answering is fetch_failed", async () => {
    const r = await egressSender({ egressUrl: "http://127.0.0.1:9", egressToken: "t".repeat(40) }).send({
      workspaceId: "ws_01jcqz1a2b3c4d5e6f7g8h9jkm",
      url: "https://r.example.test/hook",
      headers: {},
      body: "{}",
    });
    expect(r).toMatchObject({ kind: "refused", code: "fetch_failed" });
  });
});
