import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { egressSender } from "../src/index";

/** Tasks 5.2 and 5.3: the webhook sender's egress wire format (ADR-020, ADR-028 §7, ADR-029 §4). */

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
