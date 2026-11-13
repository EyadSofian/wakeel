import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { EGRESS_LIMITS } from "@wakeel/config";
import { AppError } from "@wakeel/contracts";
import { checkAddress, checkHostname } from "./address-policy";
import type { Clock } from "./clock";
import type { FetchRequest, FetchResult } from "./protocol";
import type { RateLimiter } from "./rate-limit";
import type { Resolver } from "./resolver";

/**
 * Where a checked address is dialled. Production dials the address itself (`directDial`). Tests
 * map public test addresses to local servers and everything else to a canary, so a policy bug
 * shows up as a canary hit instead of a connection to a real internal service.
 */
export type Dial = (address: string, port: number) => { host: string; port: number };
export const directDial: Dial = (host, port) => ({ host, port });

export interface FetchDeps {
  resolver: Resolver;
  clock: Clock;
  limiter: RateLimiter;
  dial: Dial;
  /** Extra trusted CAs. Unset in production: the system store applies. */
  tls?: { ca?: string[] };
}

/** What the service logs about a request. Never the path, query or headers: they can hold tenant secrets. */
export interface FetchLog {
  origin: string;
  hops: number;
  /** Which range refused the request, when one did. */
  range?: string;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Never forwarded from the caller: hop-by-hop (RFC 9110 §7.6.1), proxy credentials, or set by us. */
const DROP_REQUEST = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
  "expect",
]);

const DROP_RESPONSE = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Removed when a redirect turns the request into a body-less GET (Fetch standard, HTTP-redirect fetch). */
const BODY_HEADERS = ["content-type", "content-encoding", "content-language", "content-location"];

/** Not sent to a different origin after a redirect. */
const CREDENTIAL_HEADERS = ["authorization", "cookie"];

/**
 * Performs one tenant request on the tenant's behalf. Each hop: take a rate-limit token, resolve
 * the host once, check every address, dial the first one (DNS pinning), and only then send. The
 * deadline, response size and redirect count cover the whole request, redirects included.
 *
 * Throws `AppError`: `fetch_blocked`, `fetch_failed`, `rate_limited`, `payload_too_large`,
 * `validation_failed`. `log` is filled in as the request progresses, also when it throws.
 */
export async function performFetch(req: FetchRequest, deps: FetchDeps, log: FetchLog): Promise<FetchResult> {
  const timeoutMs = req.timeoutMs ?? EGRESS_LIMITS.timeoutMs;
  const maxBytes = req.maxResponseBytes ?? EGRESS_LIMITS.responseBytes;

  let body = req.body === undefined ? undefined : Buffer.from(req.body, req.bodyEncoding);
  if (body && body.length > EGRESS_LIMITS.requestBodyBytes) {
    throw new AppError("payload_too_large", { limit: formatBytes(EGRESS_LIMITS.requestBodyBytes) });
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "url", code: "invalid_url", message: "Not a valid URL" }] },
    );
  }
  log.origin = describe(url);

  const controller = new AbortController();
  let timedOut = false;
  const timer = deps.clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const timeoutError = () =>
    new AppError("fetch_failed", { host: url.host, message: `it did not answer within ${timeoutMs / 1000} s` });

  try {
    let method: string = req.method;
    let headers = requestHeaders(req.headers);
    for (;;) {
      const take = deps.limiter.take(req.workspaceId);
      if (!take.ok) throw new AppError("rate_limited", { retryAfter: take.retryAfterSeconds });

      const address = await pin(url, deps.resolver, controller.signal, log);
      const res = await send(url, address, method, headers, body, deps, controller.signal);
      const location = res.headers.location;

      if (req.redirect === "follow" && REDIRECTS.has(res.statusCode ?? 0) && location !== undefined) {
        res.destroy();
        log.hops += 1;
        if (log.hops > EGRESS_LIMITS.redirects) {
          throw new AppError("fetch_failed", {
            host: url.host,
            message: `it sent more than ${EGRESS_LIMITS.redirects} redirects`,
          });
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new AppError("fetch_failed", {
            host: url.host,
            message: "it redirected to an address that is not valid",
          });
        }
        if (next.origin !== url.origin) for (const h of CREDENTIAL_HEADERS) delete headers[h];
        const status = res.statusCode ?? 0;
        if ((status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          headers = { ...headers };
          for (const h of BODY_HEADERS) delete headers[h];
        }
        url = next;
        continue;
      }

      const bytes = await readBody(res, maxBytes, url);
      if (timedOut) throw timeoutError();
      return {
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? "",
        headers: responseHeaders(res, bytes.decoded),
        body: bytes.body.toString("base64"),
        url: url.href,
        redirected: log.hops > 0,
      };
    }
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    deps.clock.clearTimeout(timer);
  }
}

/** Resolves and checks the URL's host; returns the one address this hop will dial. */
async function pin(url: URL, resolver: Resolver, signal: AbortSignal, log: FetchLog): Promise<string> {
  const refuse = (range: string, host = url.hostname) => {
    log.range = range;
    return new AppError("fetch_blocked", { host });
  };
  if (url.protocol !== "http:" && url.protocol !== "https:") throw refuse(`scheme ${url.protocol}`, describe(url));

  const host = url.hostname;
  const literal = host.startsWith("[") ? host.slice(1, -1) : isIP(host) === 4 ? host : undefined;
  if (literal !== undefined) {
    const check = checkAddress(literal);
    if (!check.allowed) throw refuse(check.range);
    return literal;
  }

  const name = checkHostname(host);
  if (!name.allowed) throw refuse(name.range);

  let answers: Awaited<ReturnType<Resolver["resolve"]>>;
  try {
    answers = await abortable(resolver.resolve(host), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new AppError("fetch_failed", { host: url.host, message: "the address could not be found" }, { cause: error });
  }
  const [first] = answers;
  if (!first) throw new AppError("fetch_failed", { host: url.host, message: "the address could not be found" });
  // Every answer must pass: a client may otherwise fall back to a blocked one, and a mixed answer is
  // a rebinding tell.
  for (const answer of answers) {
    const check = checkAddress(answer.address);
    if (!check.allowed) throw refuse(check.range);
  }
  return first.address;
}

function send(
  url: URL,
  address: string,
  method: string,
  headers: OutgoingHttpHeaders,
  body: Buffer | undefined,
  deps: FetchDeps,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const https = url.protocol === "https:";
  const to = deps.dial(address, url.port === "" ? (https ? 443 : 80) : Number(url.port));
  const outgoing: OutgoingHttpHeaders = { ...headers, host: url.host, "accept-encoding": "gzip, deflate, br" };
  if (body) outgoing["content-length"] = body.length;
  else if (method === "POST" || method === "PUT" || method === "PATCH") outgoing["content-length"] = 0;

  // The socket goes to the checked address; Node never resolves the name again. For TLS the name
  // still drives SNI and certificate checks, so pinning does not weaken verification.
  const options: RequestOptions & { servername?: string; ca?: string[] } = {
    host: to.host,
    port: to.port,
    method,
    path: `${url.pathname}${url.search}`,
    headers: outgoing,
    agent: false,
    signal,
    maxHeaderSize: EGRESS_LIMITS.headerBytes,
  };
  if (https) {
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(hostname) === 0) options.servername = hostname;
    if (deps.tls?.ca) options.ca = deps.tls.ca;
  }

  return new Promise((resolve, reject) => {
    const request = (https ? httpsRequest : httpRequest)(options, resolve);
    request.on("error", (error) => reject(networkError(url, error)));
    request.end(body);
  });
}

async function readBody(res: IncomingMessage, maxBytes: number, url: URL): Promise<{ body: Buffer; decoded: boolean }> {
  const encoding = (res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
  let source: Readable = res;
  if (decoder) {
    res.on("error", (error) => decoder.destroy(error));
    source = res.pipe(decoder);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      // Counted after decoding, so a small compressed bomb cannot get past the limit.
      if (total > maxBytes) {
        res.destroy();
        decoder?.destroy();
        throw new AppError("fetch_failed", {
          host: url.host,
          message: `the response is larger than ${formatBytes(maxBytes)}`,
        });
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (decoder && !res.destroyed) {
      throw new AppError("fetch_failed", { host: url.host, message: "the response could not be decoded" });
    }
    throw networkError(url, error);
  }
  if (!res.complete) throw new AppError("fetch_failed", { host: url.host, message: "the response ended early" });
  return { body: Buffer.concat(chunks), decoded: decoder !== undefined };
}

function requestHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const lower = Object.entries(input).map(([k, v]) => [k.toLowerCase(), v] as const);
  const listed = connectionTokens(lower.find(([k]) => k === "connection")?.[1]);
  for (const [name, value] of lower) {
    if (DROP_REQUEST.has(name) || name.startsWith("proxy-") || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function responseHeaders(res: IncomingMessage, decoded: boolean): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    pairs.push([(res.rawHeaders[i] ?? "").toLowerCase(), res.rawHeaders[i + 1] ?? ""]);
  }
  const listed = connectionTokens(
    pairs
      .filter(([k]) => k === "connection")
      .map(([, v]) => v)
      .join(","),
  );
  return pairs.filter(([name]) => {
    if (DROP_RESPONSE.has(name) || listed.has(name)) return false;
    if (decoded && (name === "content-encoding" || name === "content-length")) return false;
    return true;
  });
}

function connectionTokens(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t !== ""),
  );
}

/** Maps a socket, TLS or parser error to a sentence for `fetch_failed`. Error codes only, never messages. */
function networkError(url: URL, error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = String((error as { code?: unknown }).code ?? "");
  let message = "the connection failed";
  if (code === "ECONNREFUSED") message = "the connection was refused";
  else if (code === "ECONNRESET" || code === "EPIPE") message = "the connection was closed early";
  else if (code === "ETIMEDOUT") message = "the connection timed out";
  else if (code === "HPE_HEADER_OVERFLOW")
    message = `its headers are larger than ${formatBytes(EGRESS_LIMITS.headerBytes)}`;
  else if (code.startsWith("HPE_")) message = "it sent a response that is not valid HTTP";
  else if (code.startsWith("ERR_TLS_") || code.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    message = "its certificate is not valid for this address";
  } else if (code.startsWith("ERR_SSL_") || code === "EPROTO") message = "the secure connection could not be set up";
  return new AppError("fetch_failed", { host: url.host, message }, { cause: error });
}

/** `http://example.com:8080` or `file:` — what the log and blocked titles show. */
function describe(url: URL): string {
  return url.host === "" ? url.protocol : `${url.protocol}//${url.host}`;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const MB = 1024 * 1024;

export function formatBytes(n: number): string {
  if (n >= MB && n % MB === 0) return `${n / MB} MB`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} bytes`;
}
