import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { createLogger } from "@wakeel/telemetry";
import { FakeClock } from "@wakeel/testing";
import type { ResolvedAddress, Resolver } from "../src/resolver";
import { createEgressServer, type EgressOptions } from "../src/server";

/**
 * Local stand-ins for the internet. Nothing in these tests leaves the machine:
 *
 * - The "public" servers listen on 127.0.0.1, and tests reach them through public addresses that
 *   the test resolver hands out (PUBLIC_V4, PUBLIC_V6, PUBLIC_TLS).
 * - The test dialer sends a connection to a public address to the matching local server, and a
 *   connection to **any other** address to the canary server. A canary hit means some address the
 *   policy should have blocked was dialled; every test checks there were none.
 */
export const PUBLIC_V4 = "93.184.215.14";
export const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";
export const PUBLIC_TLS = "93.184.215.15";

export const TOKEN = "test-egress-token-0123456789abcdef";
export const WORKSPACE = "ws_01jcqz5p6q7r8s9t0v1w2x3y4z";
export const OTHER_WORKSPACE = "ws_01jcqz5p6q7r8s9t0v1w2x3y5a";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
export const TLS_CERT = fixture("secure-test.crt");
const TLS_KEY = fixture("secure-test.key");

type Answer = string[] | ((call: number) => string[]);

/** A resolver tests program per name. It records every lookup so tests can count them. */
export class TestResolver implements Resolver {
  readonly calls: string[] = [];
  readonly #answers = new Map<string, Answer>();

  set(name: string, answer: Answer): void {
    this.#answers.set(name.toLowerCase(), answer);
  }

  callsFor(name: string): number {
    return this.calls.filter((c) => c === name.toLowerCase()).length;
  }

  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    const name = hostname.toLowerCase();
    this.calls.push(name);
    const answer = this.#answers.get(name);
    if (!answer) {
      const error = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as Error & { code: string };
      error.code = "ENOTFOUND";
      throw error;
    }
    const list = typeof answer === "function" ? answer(this.callsFor(name)) : answer;
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }
}

export interface Hit {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface Harness {
  egressUrl: string;
  clock: FakeClock;
  resolver: TestResolver;
  /** Requests that reached a public server, in order. */
  publicHits: Hit[];
  /** Requests that reached the canary. Must stay empty. */
  canaryHits: Hit[];
  /** Resolves when the public server receives a request for `/slow`. */
  slowArrived: () => Promise<void>;
  close: () => Promise<void>;
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

/** The public test server: a handful of routes the suites need. */
function publicRoutes(hits: Hit[], onSlow: () => void) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
    const url = new URL(req.url ?? "/", "http://public.test");
    switch (url.pathname) {
      case "/ok":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-test": "public" });
        res.end("public ok");
        return;
      case "/echo":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
        return;
      case "/redirect": {
        const status = Number(url.searchParams.get("status") ?? "302");
        res.writeHead(status, { location: url.searchParams.get("to") ?? "/ok" });
        res.end();
        return;
      }
      case "/hops": {
        // /hops?n=3 redirects to /hops?n=2 … until /ok.
        const n = Number(url.searchParams.get("n") ?? "0");
        res.writeHead(302, { location: n > 0 ? `/hops?n=${n - 1}` : "/ok" });
        res.end();
        return;
      }
      case "/bytes": {
        const n = Number(url.searchParams.get("n") ?? "0");
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(n, 0x61));
        return;
      }
      case "/gzip": {
        const n = Number(url.searchParams.get("n") ?? "0");
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.alloc(n, 0x61)));
        return;
      }
      case "/cookie":
        res.writeHead(200, [
          ["set-cookie", "a=1"],
          ["set-cookie", "b=2"],
          ["connection", "close"],
        ]);
        res.end("cookies");
        return;
      case "/slow":
        // Sends headers and nothing more; only the egress deadline ends this request.
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        onSlow();
        return;
      default:
        res.writeHead(404);
        res.end("not found");
    }
  };
}

export async function startHarness(overrides: Partial<Pick<EgressOptions, "rate">> = {}): Promise<Harness> {
  const publicHits: Hit[] = [];
  const canaryHits: Hit[] = [];
  let slowResolve: () => void = () => undefined;
  let slowPromise = new Promise<void>((r) => {
    slowResolve = r;
  });
  const onSlow = () => {
    slowResolve();
    slowPromise = new Promise<void>((r) => {
      slowResolve = r;
    });
  };

  const publicServer = createHttpServer(publicRoutes(publicHits, onSlow));
  const tlsServer = createHttpsServer({ cert: TLS_CERT, key: TLS_KEY }, publicRoutes(publicHits, onSlow));
  const canary = createHttpServer(async (req, res) => {
    canaryHits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: await readBody(req) });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("internal secret");
  });
  const [publicPort, tlsPort, canaryPort] = await Promise.all([
    listen(publicServer),
    listen(tlsServer),
    listen(canary),
  ]);

  const resolver = new TestResolver();
  resolver.set("public.test", [PUBLIC_V4]);
  resolver.set("public6.test", [PUBLIC_V6]);
  resolver.set("secure.test", [PUBLIC_TLS]);

  const clock = new FakeClock();
  const egress = createEgressServer({
    token: TOKEN,
    resolver,
    clock,
    rate: overrides.rate ?? { perMinute: 60_000, burst: 10_000 },
    logger: createLogger({ service: "egress", level: "silent" }),
    tls: { ca: [TLS_CERT] },
    dial: (address) => {
      if (address === PUBLIC_V4 || address === PUBLIC_V6) return { host: "127.0.0.1", port: publicPort };
      if (address === PUBLIC_TLS) return { host: "127.0.0.1", port: tlsPort };
      return { host: "127.0.0.1", port: canaryPort };
    },
  });
  const egressPort = await listen(egress);

  return {
    egressUrl: `http://127.0.0.1:${egressPort}`,
    clock,
    resolver,
    publicHits,
    canaryHits,
    slowArrived: () => slowPromise,
    close: async () => {
      await Promise.all([close(egress), close(publicServer), close(tlsServer), close(canary)]);
    },
  };
}

export interface EgressReply {
  status: number;
  headers: Headers;
  // biome-ignore lint/suspicious/noExplicitAny: test helper reads both problem documents and fetch results.
  json: any;
}

/** Calls the egress service the way the sandbox and worker will. */
export async function callEgress(
  h: Pick<Harness, "egressUrl">,
  body: Record<string, unknown>,
  init: { token?: string | null } = {},
): Promise<EgressReply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${h.egressUrl}/v1/fetch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspaceId: WORKSPACE, ...body }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text === "" ? undefined : JSON.parse(text) };
}

export const decode = (reply: EgressReply) => Buffer.from(reply.json.body as string, "base64").toString("utf8");
