import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createAuthService } from "@wakeel/auth";
import { API_LIMITS } from "@wakeel/config";
import { createDatabase, type Database } from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase } from "@wakeel/db/testing";
import { createLogger } from "@wakeel/telemetry";
import { Redis } from "ioredis";
import { expect } from "vitest";
import { type App, buildApp } from "../src/app";
import { Signals } from "../src/routes/bridge/signals";
import type { StudioDeps } from "../src/studio";
import { standInWorker } from "./stand-in-worker";

/** The api on real Postgres (app_rw) and Redis, as main.ts wires it, for Studio API tests. */
export const REDIS_IMAGE =
  "redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335";
export const STUDIO = "https://studio.wakeel.test";
export const PASSWORD = "correct horse battery";

export interface Stack {
  app: App;
  db: Database;
  pg: StartedTestDatabase;
  /** With `bridge: true`: conversations enqueued for a turn, in order. */
  jobs: string[];
  /** With `bridge: true`: run the stand-in worker for each enqueued conversation at once. */
  autoWork: { on: boolean };
  stop(): Promise<void>;
}

export async function startStack(
  options: { now?: () => Date; extraRoutes?: (app: App, deps: StudioDeps) => void; bridge?: boolean } = {},
): Promise<Stack> {
  const [pg, redisContainer]: [StartedTestDatabase, StartedRedisContainer] = await Promise.all([
    startTestDatabase(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);
  const db = createDatabase({ url: pg.urls.rw });
  const redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: 1 });
  const auth = createAuthService({
    db,
    redis,
    secret: "test-only-auth-secret-0123456789abcdef",
    baseUrl: "https://api.wakeel.test",
    studioOrigin: STUDIO,
    signInFailuresPerMinute: API_LIMITS.signInFailuresPerMinute,
  });
  const deps: StudioDeps = { auth, studioOrigin: STUDIO, db, now: options.now ?? (() => new Date()) };
  const jobs: string[] = [];
  const autoWork = { on: false };
  // The Bridge deps, for routes that run the inbound path (the Studio emulator, ADR-025).
  const publisher = options.bridge ? new Redis(redisContainer.getConnectionUrl()) : undefined;
  const subscriber = options.bridge ? new Redis(redisContainer.getConnectionUrl()) : undefined;
  const work = publisher ? standInWorker(db, publisher) : undefined;
  const app = buildApp({
    role: "all",
    logger: createLogger({ service: "api", level: (process.env["TEST_LOG"] as "error" | undefined) ?? "silent" }),
    studio: deps,
    ...(subscriber && work
      ? {
          bridge: {
            db,
            signals: new Signals(subscriber),
            enqueueTurn: async (conversationId: string) => {
              jobs.push(conversationId);
              if (autoWork.on) setImmediate(() => void work(conversationId));
            },
            // A wait ends only by the turn-done signal while the stand-in runs; at once otherwise.
            sleep: () => (autoWork.on ? new Promise<void>(() => {}) : Promise.resolve()),
          },
        }
      : {}),
  });
  options.extraRoutes?.(app, deps);
  await app.ready();
  return {
    app,
    db,
    pg,
    jobs,
    autoWork,
    async stop() {
      await app.close();
      await Promise.allSettled([db.close(), redis.quit(), publisher?.quit(), subscriber?.quit()]);
      await Promise.allSettled([pg.stop(), redisContainer.stop()]);
    },
  };
}

let counter = 0;
export const uniqueEmail = () => `user${Date.now()}${counter++}@example.test`;

type InjectResponse = Awaited<ReturnType<App["inject"]>>;

/** A signed-up user and what a browser would send back: the cookie and the CSRF token. */
export interface Browser {
  userId: string;
  email: string;
  cookie: string;
  csrf: string;
  get(url: string): Promise<InjectResponse>;
  send(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown): Promise<InjectResponse>;
}

const cookieHeader = (raw: unknown) =>
  (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).map((c: string) => c.split(";")[0]).join("; ");

export async function signUp(app: App, email = uniqueEmail(), name = "عضو Test"): Promise<Browser> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up",
    headers: { origin: STUDIO },
    payload: { name, email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  const cookie = cookieHeader(res.headers["set-cookie"]);
  const csrf = res.json().csrfToken as string;
  return {
    userId: res.json().user.id,
    email,
    cookie,
    csrf,
    get: (url) => app.inject({ method: "GET", url, headers: { cookie } }),
    send: (method, url, body) =>
      app.inject({
        method,
        url,
        headers: { cookie, origin: STUDIO, "x-csrf-token": csrf },
        ...(body === undefined ? {} : { payload: body as object }),
      }),
  };
}
