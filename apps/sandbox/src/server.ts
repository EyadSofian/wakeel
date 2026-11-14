/**
 * The sandbox's HTTP surface (architecture §5.1): `POST /exec`, a bidirectional NDJSON stream, and
 * the two health checks. Internal network only; no route reads or returns tenant data beyond the
 * exec's own frames, and the request frame (source, scopes, capability token) is never logged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BRAND } from "@wakeel/config/brand";
import { AppError, ERRORS, type FieldError, formatPath, newRequestId, type Problem } from "@wakeel/contracts";
import type { Logger } from "@wakeel/telemetry";
import type { SandboxPool } from "./pool.ts";
import { ExecRequestFrame, NDJSON_CONTENT_TYPE, ToolResultFrame } from "./protocol.ts";

const PROBLEM_CONTENT_TYPE = "application/problem+json";
/** How long the rest of a refused, oversized body is read before the connection is closed. */
const DRAIN_MS = 10_000;

export interface ServerOptions {
  pool: SandboxPool;
  logger: Logger;
  /** Largest single NDJSON line accepted. */
  requestFrameBytes: number;
}

export interface SandboxServer {
  listen(port: number, host: string, onListening: () => void): void;
  address(): AddressInfo | string | null;
  /** Stops accepting connections and drops open ones. */
  close(): Promise<void>;
}

export function createSandboxServer(options: ServerOptions): SandboxServer {
  const server: Server = createServer((req, res) => {
    void route(options, req, res).catch((error: unknown) => {
      options.logger.error({ err: error }, "request failed");
      if (!res.headersSent) sendProblem(res, new AppError("internal_error"), newRequestId());
      else res.destroy();
    });
  });
  return {
    listen: (port, host, onListening) => {
      server.listen(port, host, onListening);
    },
    address: () => server.address(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function route(options: ServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/health/live") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (req.method === "GET" && path === "/health/ready") {
    const pool = options.pool.health();
    sendJson(res, pool.ready ? 200 : 503, { status: pool.ready ? "ok" : "unavailable", pool });
    return;
  }
  if (req.method === "POST" && path === "/exec") {
    await exec(options, req, res);
    return;
  }
  req.resume();
  sendProblem(res, new AppError("not_found"), newRequestId());
}

async function exec(options: ServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = newRequestId();
  const lines = readLines(req, options.requestFrameBytes);

  const first = await lines.next();
  if (first.done || first.value.kind === "eof") {
    sendProblem(res, invalid("", "The request body is empty; send one exec request frame."), requestId);
    return;
  }
  if (first.value.kind === "too_large") {
    // Keep reading, and throwing away, the rest of the body, and keep the connection open meanwhile:
    // closing it while the caller is still sending makes the caller see a reset instead of the 413.
    // The reader never holds more than one frame, and a body that has not ended within DRAIN_MS is
    // cut off.
    const cutOff = setTimeout(() => req.destroy(), DRAIN_MS);
    cutOff.unref();
    req.on("close", () => clearTimeout(cutOff));
    void (async () => {
      for await (const _ of lines) {
        // Discarded.
      }
    })();
    sendProblem(res, tooLarge(options.requestFrameBytes), requestId);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(first.value.line);
  } catch {
    sendProblem(res, invalid("", "The first line is not JSON."), requestId);
    return;
  }
  const frame = ExecRequestFrame.safeParse(parsed);
  if (!frame.success) {
    const errors: FieldError[] = frame.error.issues.map((issue) => ({
      path: formatPath(issue.path),
      code: issue.code,
      message: issue.message,
    }));
    sendProblem(res, new AppError("validation_failed", {}, { errors }), requestId);
    return;
  }

  const request = frame.data;
  const log = options.logger.child({ requestId, execId: request.execId, kind: request.kind });
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(new Error("the caller closed the exec stream"));
  });

  const running = options.pool.exec(
    {
      execId: request.execId,
      kind: request.kind,
      source: request.source,
      timeoutMs: request.limits.timeoutMs,
      memoryMb: request.limits.memoryMb,
      scopes: request.scopes,
      secretKeys: request.secretKeys,
      tables: request.tables,
      ...(request.ctx ? { idempotencyKey: request.ctx.idempotencyKey } : {}),
      ...(request.capabilityToken ? { capabilityToken: request.capabilityToken } : {}),
    },
    {
      signal: controller.signal,
      onFrame: (out) => writeFrame(res, out),
    },
  );

  // Refusals (unsupported kind, full queue, no runner) are known before anything streams, so they
  // are problem documents. Everything after this point is a frame on a 200 stream.
  const early = await Promise.race([running.then(() => undefined), settleTick()]).catch((error: unknown) => error);
  if (early instanceof AppError) {
    req.resume();
    sendProblem(res, early, requestId);
    return;
  }

  res.writeHead(200, { "content-type": NDJSON_CONTENT_TYPE, "cache-control": "no-store" });
  res.flushHeaders();
  void forwardHostFrames(options.pool, request.execId, lines, log);

  try {
    const outcome = await running;
    if (outcome.t === "error") log.info({ code: outcome.code }, "exec failed");
    writeFrame(res, outcome);
    res.end();
  } catch (error) {
    if (controller.signal.aborted) {
      log.info("exec cancelled by the caller");
      return;
    }
    throw error;
  }
}

/** Later lines from the caller answer tool calls (task 3.3). */
async function forwardHostFrames(
  pool: SandboxPool,
  execId: string,
  lines: AsyncGenerator<Line>,
  log: Logger,
): Promise<void> {
  for await (const next of lines) {
    if (next.kind === "eof") return;
    if (next.kind === "too_large") {
      log.warn("dropped a caller frame over the size limit");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(next.line);
    } catch {
      log.warn("dropped a caller frame that is not JSON");
      continue;
    }
    const frame = ToolResultFrame.safeParse(parsed);
    if (!frame.success || !pool.deliver(execId, frame.data)) {
      log.warn("dropped a caller frame that answers no pending call");
    }
  }
}

type Line = { kind: "line"; line: string } | { kind: "too_large" } | { kind: "eof" };

/** Splits the request body into lines without holding more than `maxBytes` of one line. */
async function* readLines(req: IncomingMessage, maxBytes: number): AsyncGenerator<Line> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let skipping = false;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      let rest = chunk;
      for (;;) {
        const at = rest.indexOf(0x0a);
        const piece = at < 0 ? rest : rest.subarray(0, at);
        if (!skipping) {
          pendingBytes += piece.length;
          if (pendingBytes > maxBytes) {
            pending = [];
            pendingBytes = 0;
            skipping = true;
            yield { kind: "too_large" };
          } else {
            pending.push(piece);
          }
        }
        if (at < 0) break;
        if (!skipping) {
          const line = Buffer.concat(pending).toString("utf8");
          if (line.trim() !== "") yield { kind: "line", line };
        }
        pending = [];
        pendingBytes = 0;
        skipping = false;
        rest = rest.subarray(at + 1);
      }
    }
  } catch {
    // The caller went away mid-body; whatever arrived is all there is.
  }
  if (!skipping && pendingBytes > 0) {
    const line = Buffer.concat(pending).toString("utf8");
    if (line.trim() !== "") yield { kind: "line", line };
  }
  yield { kind: "eof" };
}

/** One macrotask: long enough for the pool to refuse synchronously-known cases, never more. */
const settleTick = () => new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)));

function writeFrame(res: ServerResponse, frame: unknown): void {
  if (!res.writableEnded) res.write(`${JSON.stringify(frame)}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendProblem(
  res: ServerResponse,
  error: AppError,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): void {
  const params = error.code === "internal_error" ? { ...error.params, requestId } : error.params;
  const problem: Problem = {
    type: `${BRAND.docsUrl}/errors/${error.code}`,
    title: error.title,
    status: ERRORS[error.code].status,
    code: error.code,
    fix: new AppError(error.code, params).fix,
    requestId,
  };
  if (error.detail !== undefined) problem.detail = error.detail;
  if (error.errors !== undefined) problem.errors = error.errors;
  const headers: Record<string, string> = {
    "content-type": PROBLEM_CONTENT_TYPE,
    "cache-control": "no-store",
    ...extraHeaders,
  };
  if (error.code === "rate_limited") headers["retry-after"] = String(error.params["retryAfter"] ?? 1);
  res.writeHead(problem.status, headers);
  res.end(JSON.stringify(problem));
}

const invalid = (path: string, message: string) =>
  new AppError("validation_failed", {}, { errors: [{ path, code: "invalid_frame", message }] });

const tooLarge = (bytes: number) =>
  new AppError("payload_too_large", { limit: `${Math.floor(bytes / 1024)} KB per frame` });
