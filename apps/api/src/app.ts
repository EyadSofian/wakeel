import { AppError, newRequestId, REQUEST_ID_PATTERN } from "@wakeel/contracts";
import type { Logger } from "@wakeel/telemetry";
import Fastify from "fastify";
import { PROBLEM_CONTENT_TYPE, toAppError, toProblem } from "./problem";
import { authRoutes } from "./routes/auth";
import { invitationRoutes } from "./routes/invitations";
import { memberRoutes } from "./routes/members";
import { workspaceRoutes } from "./routes/workspaces";
import type { StudioDeps } from "./studio";

export type Role = "studio" | "bridge" | "all";

/** A dependency the service needs to serve traffic; resolves when healthy, throws otherwise. */
export type ReadinessCheck = () => Promise<void>;

export interface AppOptions {
  role: Role;
  logger: Logger;
  /** Checked by GET /health/ready, for example the database and Redis. */
  readiness?: Record<string, ReadinessCheck>;
  /** Per-check limit for /health/ready. */
  readinessTimeoutMs?: number;
  /** The Studio API (sign-in, workspaces, members); mounted for roles studio and all. */
  studio?: Omit<StudioDeps, "now"> & { now?: () => Date };
  /** Fastify `trustProxy`: which proxies may set X-Forwarded-For. Off by default. */
  trustProxy?: boolean | string | string[];
}

const REQUEST_ID_HEADER = "x-request-id";

/**
 * The api service (architecture §1.1): one Fastify instance; `role` selects which route groups mount
 * so the Bridge API can scale apart from the Studio API. Every failure leaves as an RFC 9457 problem
 * document with a code from errors.ts (ADR-012); every request has a `req_` id in its logs and in the
 * `X-Request-Id` response header.
 */
export function buildApp(options: AppOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    // Accept the caller's request id only in our own format; otherwise mint one. An arbitrary
    // incoming value would end up in logs and problem documents.
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      return typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming) ? incoming : newRequestId();
    },
    return503OnClosing: true,
    trustProxy: options.trustProxy ?? false,
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  app.setNotFoundHandler(async (request, reply) => {
    const problem = toProblem(new AppError("not_found"), request.id);
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const appError = toAppError(error);
    const problem = toProblem(appError, request.id);
    if (problem.status >= 500) {
      request.log.error({ err: error, code: problem.code }, "request failed");
    } else {
      request.log.info({ code: problem.code, status: problem.status }, "request rejected");
    }
    return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const checks = Object.entries(options.readiness ?? {});
    const timeoutMs = options.readinessTimeoutMs ?? 2_000;
    const results = await Promise.all(
      checks.map(async ([name, check]) => {
        try {
          await withTimeout(check(), timeoutMs);
          return [name, "ok"] as const;
        } catch (err) {
          app.log.warn({ check: name, err }, "readiness check failed");
          return [name, "failed"] as const;
        }
      }),
    );
    const ok = results.every(([, r]) => r === "ok");
    // Names and outcomes only: failure details stay in the log.
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ok" : "unavailable", checks: Object.fromEntries(results) });
  });

  // Route groups mount here as phases add them: Studio API under /v1/workspaces (roles studio, all),
  // Bridge API under /v1/bridge (roles bridge, all).
  app.decorate("role", options.role);

  if (options.studio && options.role !== "bridge") {
    const deps: StudioDeps = { ...options.studio, now: options.studio.now ?? (() => new Date()) };
    void app.register(authRoutes, deps);
    void app.register(workspaceRoutes, deps);
    void app.register(memberRoutes, deps);
    void app.register(invitationRoutes, deps);
  }

  return app;
}

export type App = ReturnType<typeof buildApp>;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

declare module "fastify" {
  interface FastifyInstance {
    role: Role;
  }
}
