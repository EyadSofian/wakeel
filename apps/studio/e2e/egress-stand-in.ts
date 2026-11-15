/**
 * Test-only (ADR-030 §5): an egress stand-in for the Connections E2E test, and the local webhook
 * receiver behind it. Production egress refuses loopback addresses and must never get an exception,
 * so for this run the api and the worker set EGRESS_URL to this process instead.
 *
 * - `POST /v1/fetch` (port 4498) speaks egress's wire format (ADR-020) and forwards
 *   `https://receiver.e2e.test/<path>` to the receiver; any other host is refused as `fetch_blocked`.
 * - The receiver (port 4497) records every request and answers with the status the test sets.
 *   `GET /__received` lists what arrived; `POST /__answer {status}` sets the answer.
 *
 * Never imported by application code; started by `playwright.e2e.config.ts`.
 */
import { createServer, type IncomingMessage } from "node:http";

const EGRESS_PORT = 4498;
const RECEIVER_PORT = 4497;
const TOKEN = process.env["EGRESS_TOKEN"] ?? "";
const RECEIVER_HOST = "receiver.e2e.test";

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => resolve(body));
  });

const received: { path: string; headers: Record<string, string>; body: string }[] = [];
let answer = 200;

createServer(async (req, res) => {
  const body = await read(req);
  if (req.method === "GET" && req.url === "/__received") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(received));
    return;
  }
  if (req.method === "POST" && req.url === "/__answer") {
    answer = Number(JSON.parse(body).status);
    res.writeHead(204);
    res.end();
    return;
  }
  received.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body });
  res.writeHead(answer, { "content-type": "application/json" });
  res.end("{}");
}).listen(RECEIVER_PORT, "127.0.0.1");

createServer(async (req, res) => {
  const reply = (status: number, json: unknown) => {
    res.writeHead(status, { "content-type": status === 200 ? "application/json" : "application/problem+json" });
    res.end(JSON.stringify(json));
  };
  if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true });
  if (req.method !== "POST" || req.url !== "/v1/fetch") return reply(404, { code: "not_found", title: "Not found" });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { code: "unauthenticated", title: "No" });
  const call = JSON.parse(await read(req)) as {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  };
  const url = new URL(call.url);
  if (url.hostname !== RECEIVER_HOST)
    return reply(403, { code: "fetch_blocked", title: "Blocked", detail: url.hostname });
  const upstream = await fetch(`http://127.0.0.1:${RECEIVER_PORT}${url.pathname}${url.search}`, {
    method: call.method,
    headers: call.headers,
    ...(call.body === undefined ? {} : { body: call.body }),
    redirect: "manual",
  });
  const text = await upstream.text();
  reply(200, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: [...upstream.headers.entries()],
    body: Buffer.from(text).toString("base64"),
    url: call.url,
    redirected: false,
  });
}).listen(EGRESS_PORT, "127.0.0.1");
