import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { errorOf, resultOf, runWithHost } from "./host";

/**
 * The guest `fetch` and `axios` (architecture §5.2, ADR-023 §4) against a stand-in egress service
 * that records what the sandbox sends. The real proxy is exercised in `fetch-egress.test.ts`.
 */

interface Received {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

let egress: Server;
let pool: SandboxPool;
const received: Received[] = [];
let inFlight = 0;
let most = 0;

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const reply = (status: number, body: string, headers: [string, string][] = [], url = "https://api.example/x") => ({
  status,
  statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
  headers,
  body: Buffer.from(body, "utf8").toString("base64"),
  url,
  redirected: false,
});

beforeAll(async () => {
  egress = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    received.push({ authorization: req.headers.authorization, body });
    const target = new URL(String(body["url"]));
    const send = (status: number, payload: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(JSON.stringify(payload));
    };
    switch (target.pathname) {
      case "/json":
        return send(200, reply(200, JSON.stringify({ name: "متجر", n: 1 }), [["content-type", "application/json"]]));
      case "/text":
        return send(
          200,
          reply(200, "plain text", [
            ["content-type", "text/plain"],
            ["set-cookie", "a=1"],
            ["set-cookie", "b=2"],
          ]),
        );
      case "/missing":
        return send(200, reply(404, "nope", [["content-type", "text/plain"]]));
      case "/echo":
        return send(200, reply(200, JSON.stringify(body), [["content-type", "application/json"]]));
      case "/slow": {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return send(200, reply(200, "slow"));
      }
      case "/blocked":
        return send(
          403,
          {
            type: "x",
            title: "Requests to 10.0.0.1 are not allowed",
            status: 403,
            code: "fetch_blocked",
            fix: "x",
            requestId: "req_1",
          },
          "application/problem+json",
        );
      case "/broken":
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{ not json");
        return;
      default:
        return send(200, reply(200, ""));
    }
  });
  await new Promise<void>((resolve) => egress.listen(0, "127.0.0.1", resolve));
  pool = new SandboxPool({ size: 2, egressUrl: `http://127.0.0.1:${(egress.address() as AddressInfo).port}` });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
  await new Promise<void>((resolve) => egress.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
});

const CAP = "wkc1.payload.signature";
const run = (source: string, options: Parameters<typeof runWithHost>[2] = {}) =>
  runWithHost(pool, source, { capabilityToken: CAP, ...options });

describe("fetch", () => {
  test("sends the request to egress with the exec's capability token and no workspace id", async () => {
    const r = await run(
      "const res = await fetch('https://api.example/echo', { method: 'POST', headers: { 'x-a': 'b' }, body: 'hi' }); return res.status;",
      { timeoutMs: 3_000 },
    );
    expect(resultOf(r.outcome).value).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(`Capability ${CAP}`);
    const body = received[0]?.body ?? {};
    expect(body).toMatchObject({
      url: "https://api.example/echo",
      method: "POST",
      headers: { "x-a": "b" },
      body: "hi",
    });
    expect(body).not.toHaveProperty("workspaceId");
    // The time left before the exec deadline, never more than egress's own limit.
    expect(Number(body["timeoutMs"])).toBeGreaterThan(0);
    expect(Number(body["timeoutMs"])).toBeLessThanOrEqual(3_000);
  });

  test("the response has ok, status, statusText, url, headers, text and json", async () => {
    const r = await run(`
      const res = await fetch('https://api.example/json');
      const copy = await fetch('https://api.example/json');
      return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url,
               type: res.headers.get('Content-Type'), none: res.headers.get('x-none'),
               json: await res.json(), text: await copy.text() };`);
    expect(resultOf(r.outcome).value).toEqual({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://api.example/x",
      type: "application/json",
      none: null,
      json: { name: "متجر", n: 1 },
      text: JSON.stringify({ name: "متجر", n: 1 }),
    });
  });

  test("repeated headers are joined", async () => {
    const r = await run("const res = await fetch('https://api.example/text'); return res.headers.get('set-cookie');");
    expect(resultOf(r.outcome).value).toBe("a=1, b=2");
  });

  test("a 404 from the remote service is a response, not an error", async () => {
    const r = await run(
      "const res = await fetch('https://api.example/missing'); return [res.ok, res.status, await res.text()];",
    );
    expect(resultOf(r.outcome).value).toEqual([false, 404, "nope"]);
  });

  test("an egress refusal rejects with an Error carrying the code", async () => {
    const r = await run(
      "try { await fetch('https://api.example/blocked'); } catch (e) { return [e instanceof Error, e.code, e.message]; }",
    );
    expect(resultOf(r.outcome).value).toEqual([true, "fetch_blocked", "Requests to 10.0.0.1 are not allowed"]);
  });

  test("an uncaught refusal is code_error at the line of the fetch", async () => {
    const e = errorOf((await run("const a = 1;\nawait fetch('https://api.example/blocked');")).outcome);
    expect(e).toMatchObject({ code: "code_error", line: 2 });
  });

  test("an egress answer that is not valid is fetch_failed", async () => {
    const r = await run("try { await fetch('https://api.example/broken'); } catch (e) { return e.code; }");
    expect(resultOf(r.outcome).value).toBe("fetch_failed");
  });

  test("an exec without a capability token has no network access", async () => {
    const r = await runWithHost(
      pool,
      "try { await fetch('https://api.example/json'); } catch (e) { return [e.code, e.message]; }",
    );
    expect(resultOf(r.outcome).value).toEqual(["fetch_failed", "this run has no network access"]);
    expect(received).toHaveLength(0);
  });

  test("bad arguments are rejected in the guest before anything is sent", async () => {
    const r = await run(`
      const out = [];
      for (const args of [[42], ['https://a.example', { method: 'TRACE' }], ['https://a.example', { body: {} }],
                          ['https://a.example', { headers: { a: 1 } }]]) {
        try { await fetch(...args); out.push('sent'); } catch (e) { out.push(e.name); }
      }
      return out;`);
    expect(resultOf(r.outcome).value).toEqual(["TypeError", "TypeError", "TypeError", "TypeError"]);
    expect(received).toHaveLength(0);
  });

  test("at most 4 fetches are in flight at once; the rest wait", async () => {
    most = 0;
    const r = await run(
      "const all = await Promise.all(Array.from({ length: 10 }, () => fetch('https://api.example/slow'))); return all.length;",
      { timeoutMs: 5_000 },
    );
    expect(resultOf(r.outcome).value).toBe(10);
    expect(most).toBeLessThanOrEqual(4);
    expect(most).toBeGreaterThan(1);
  });

  test("the capability token never appears in frames or the result", async () => {
    const r = await run(
      "const res = await fetch('https://api.example/json'); log.info(res.status); return res.status;",
    );
    expect(JSON.stringify(r)).not.toContain(CAP);
  });
});

describe("axios", () => {
  test("get adds params to the URL and parses JSON data", async () => {
    const r = await run(
      "const res = await axios.get('https://api.example/json', { params: { q: 'عربي', n: 2 } }); return [res.status, res.data, res.headers['content-type']];",
    );
    expect(resultOf(r.outcome).value).toEqual([200, { name: "متجر", n: 1 }, "application/json"]);
    expect(received[0]?.body["url"]).toBe(`https://api.example/json?q=${encodeURIComponent("عربي")}&n=2`);
    expect(received[0]?.body["method"]).toBe("GET");
  });

  test("post sends JSON data with a JSON content type", async () => {
    const r = await run("const res = await axios.post('https://api.example/echo', { a: 1 }); return res.data.body;");
    expect(resultOf(r.outcome).value).toBe(JSON.stringify({ a: 1 }));
    expect(received[0]?.body).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
  });

  test("put, patch and delete use their methods", async () => {
    await run(
      "await axios.put('https://api.example/x', { a: 1 }); await axios.patch('https://api.example/x', { a: 2 }); await axios.delete('https://api.example/x');",
    );
    expect(received.map((x) => x.body["method"])).toEqual(["PUT", "PATCH", "DELETE"]);
  });

  test("a text response is returned as text", async () => {
    const r = await run("return (await axios.get('https://api.example/text')).data;");
    expect(resultOf(r.outcome).value).toBe("plain text");
  });

  test("a status outside 2xx rejects with the response attached, like axios", async () => {
    const r = await run(
      "try { await axios.get('https://api.example/missing'); } catch (e) { return [e.message, e.code, e.response.status, e.response.data]; }",
    );
    expect(resultOf(r.outcome).value).toEqual(["Request failed with status code 404", "fetch_failed", 404, "nope"]);
  });
});
