import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EGRESS_LIMITS } from "@wakeel/config";
import { BRAND } from "@wakeel/config/brand";
import { AppError, ERRORS, formatPath, newRequestId, type Problem, verifyCapabilityToken } from "@wakeel/contracts";
import type { Logger } from "@wakeel/telemetry";
import type { Clock } from "./clock";
import { type Dial, directDial, type FetchLog, formatBytes, performFetch } from "./fetch";
import { FetchRequest } from "./protocol";
import { RateLimiter, type RateSettings } from "./rate-limit";
import type { Resolver } from "./resolver";

export interface EgressOptions {
  /** Shared with platform callers (webhook delivery, crawler); compared in constant time. */
  token: string;
  /**
   * Verifies exec capability tokens minted by the worker (ADR-023 §4). The sandbox sends those and
   * never holds `token`; egress takes the workspace from the token.
   */
  capabilityKey: string;
  resolver: Resolver;
  clock: Clock;
  rate: RateSettings;
  logger: Logger;
  /** Test seam only; never read from configuration. See `Dial`. */
  dial?: Dial;
  /** Test seam only: extra trusted CAs. */
  tls?: { ca?: string[] };
}

const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** JSON request bodies carry the payload as base64 (4/3 of its size) plus a little structure. */
const MAX_JSON_BYTES = Math.ceil(EGRESS_LIMITS.requestBodyBytes / 3) * 4 + 64 * 1024;

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The egress service (task 3.1, ADR-020): `GET /health` and `POST /v1/fetch`. It is the only path
 * from the sandbox, crawler and webhook delivery to tenant URLs (CLAUDE.md §9).
 */
export function createEgressServer(options: EgressOptions): Server {
  const limiter = new RateLimiter(options.clock, options.rate);
  const expected = digest(options.token);
  const deps = {
    resolver: options.resolver,
    clock: options.clock,
    limiter,
    dial: options.dial ?? directDial,
    tls: options.tls,
  };
  const { logger } = options;

  /** Who is calling: a platform service, an exec for one workspace, or nobody we know. */
  const authorise = async (req: IncomingMessage): Promise<{ workspaceId?: string } | undefined> => {
    const header = req.headers.authorization ?? "";
    const bearer = /^Bearer (.+)$/.exec(header);
    if (bearer) return timingSafeEqual(digest(bearer[1] ?? ""), expected) ? {} : undefined;
    const capability = /^Capability (.+)$/.exec(header);
    if (capability) {
      const nowSeconds = Math.floor(options.clock.now() / 1000);
      const claims = await verifyCapabilityToken(options.capabilityKey, capability[1] ?? "", nowSeconds);
      return claims ? { workspaceId: claims.ws } : undefined;
    }
    return undefined;
  };

  return createServer(async (req, res) => {
    const requestId = newRequestId({ now: options.clock.now() });
    const path = new URL(req.url ?? "/", "http://egress").pathname;
    try {
      if (path === "/health" && req.method === "GET") {
        return sendJson(res, 200, { status: "ok" });
      }
      if (path !== "/v1/fetch" || req.method !== "POST") throw new AppError("not_found");
      const caller = await authorise(req);
      if (!caller) throw new AppError("unauthenticated");

      let body = await readJson(req);
      if (caller.workspaceId !== undefined && typeof body === "object" && body !== null && !Array.isArray(body)) {
        // The token names the workspace. The body may leave it out or repeat it, never change it.
        const named = (body as Record<string, unknown>)["workspaceId"];
        if (named !== undefined && named !== caller.workspaceId) {
          throw new AppError(
            "validation_failed",
            {},
            {
              errors: [
                {
                  path: "workspaceId",
                  code: "mismatch",
                  message: "Does not match the workspace of the capability token",
                },
              ],
            },
          );
        }
        body = { ...body, workspaceId: caller.workspaceId };
      }

      const parsed = FetchRequest.safeParse(body);
      if (!parsed.success) {
        throw new AppError(
          "validation_failed",
          {},
          {
            errors: parsed.error.issues.map((i) => ({ path: formatPath(i.path), code: i.code, message: i.message })),
          },
        );
      }

      const log: FetchLog = { origin: "", hops: 0 };
      try {
        const result = await performFetch(parsed.data, deps, log);
        logger.info({ requestId, workspaceId: parsed.data.workspaceId, ...log, status: result.status }, "fetched");
        return sendJson(res, 200, result);
      } catch (error) {
        const code = error instanceof AppError ? error.code : "internal_error";
        logger.info({ requestId, workspaceId: parsed.data.workspaceId, ...log, code }, "fetch refused or failed");
        throw error;
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("internal_error", {}, { cause: error });
      if (appError.code === "internal_error") logger.error({ requestId, err: error }, "egress request failed");
      sendProblem(res, appError, requestId);
    }
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) {
        return reject(new AppError("payload_too_large", { limit: formatBytes(EGRESS_LIMITS.requestBodyBytes) }));
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(
          new AppError(
            "validation_failed",
            {},
            { errors: [{ path: "", code: "invalid_json", message: "Not valid JSON" }] },
          ),
        );
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendProblem(res: ServerResponse, error: AppError, requestId: string): void {
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
  if (error.code === "rate_limited") res.setHeader("retry-after", String(error.params["retryAfter"] ?? 1));
  sendJson(res, problem.status, problem, PROBLEM_CONTENT_TYPE);
}
