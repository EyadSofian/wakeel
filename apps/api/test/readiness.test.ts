import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createDatabase, type Database } from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase } from "@wakeel/db/testing";
import { createLogger } from "@wakeel/telemetry";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";

/** Readiness against real Postgres (app_rw) and Redis, wired as main.ts wires them. */
const REDIS_IMAGE = "redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335";

let pg: StartedTestDatabase;
let redisContainer: StartedRedisContainer;
let db: Database;
let redis: Redis;

beforeAll(async () => {
  [pg, redisContainer] = await Promise.all([startTestDatabase(), new RedisContainer(REDIS_IMAGE).start()]);
  db = createDatabase({ url: pg.urls.rw });
  redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: 1 });
});

afterAll(async () => {
  await Promise.allSettled([db?.close(), redis?.quit()]);
  await Promise.allSettled([pg?.stop(), redisContainer?.stop()]);
});

test("ready is ok when Postgres (as app_rw) and Redis answer", async () => {
  const app = buildApp({
    role: "all",
    logger: createLogger({ service: "api", level: "silent" }),
    readiness: {
      database: async () => void (await db.verify()),
      redis: async () => {
        if ((await redis.ping()) !== "PONG") throw new Error("no PONG");
      },
    },
  });
  const res = await app.inject({ method: "GET", url: "/health/ready" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: "ok", checks: { database: "ok", redis: "ok" } });
  await app.close();
});

test("ready fails when the database role could bypass RLS", async () => {
  const superuser = createDatabase({ url: pg.urls.superuser });
  const app = buildApp({
    role: "all",
    logger: createLogger({ service: "api", level: "silent" }),
    readiness: { database: async () => void (await superuser.verify()) },
  });
  const res = await app.inject({ method: "GET", url: "/health/ready" });
  expect(res.json()).toEqual({ status: "unavailable", checks: { database: "failed" } });
  await app.close();
  await superuser.close();
});
