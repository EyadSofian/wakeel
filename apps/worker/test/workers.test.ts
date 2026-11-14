import { Writable } from "node:stream";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { AppError } from "@wakeel/contracts";
import { createLogger } from "@wakeel/telemetry";
import { Queue, QueueEvents } from "bullmq";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startWorkers } from "../src/workers";

/** Integration against a real Redis (same image as docker-compose). */
const REDIS_IMAGE = "redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335";

let redis: StartedRedisContainer;
let url: string;
const logs: Record<string, unknown>[] = [];
const logger = createLogger({
  service: "worker",
  level: "debug",
  destination: new Writable({
    write(chunk, _e, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) logs.push(JSON.parse(line));
      done();
    },
  }),
});

beforeAll(async () => {
  redis = await new RedisContainer(REDIS_IMAGE).start();
  url = redis.getConnectionUrl();
});

afterAll(async () => {
  await redis?.stop();
});

const connection = () => ({ url, maxRetriesPerRequest: null });

describe("startWorkers", () => {
  test("consumes only the selected queues that have a processor, and logs each job", async () => {
    const seen: string[] = [];
    const running = startWorkers({
      redisUrl: url,
      queues: ["maintenance", "eval"],
      processors: {
        maintenance: async (job) => {
          seen.push(job.name);
          return { ok: true };
        },
        turn: async () => undefined,
      },
      logger,
    });
    expect(running.consuming).toEqual(["maintenance"]);
    expect(running.idle).toEqual(["eval"]);
    await running.ready();

    const queue = new Queue("maintenance", { connection: connection() });
    const events = new QueueEvents("maintenance", { connection: connection() });
    await events.waitUntilReady();
    const job = await queue.add("partition-create", { month: "2026-12" });
    await expect(job.waitUntilFinished(events, 10_000)).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["partition-create"]);

    const done = logs.find((l) => l["msg"] === "job completed" && l["jobId"] === job.id);
    expect(done).toMatchObject({ service: "worker", queue: "maintenance", jobName: "partition-create", attempt: 1 });
    expect(typeof done?.["durationMs"]).toBe("number");

    await running.close();
    await Promise.all([queue.close(), events.close()]);
  });

  test("a failing job is logged with its error code and reported as failed", async () => {
    const running = startWorkers({
      redisUrl: url,
      queues: ["kb-sync"],
      processors: {
        "kb-sync": async () => {
          throw new AppError("source_fetch_failed", { url: "https://example.com", message: "timeout" });
        },
      },
      logger,
    });
    await running.ready();
    const queue = new Queue("kb-sync", { connection: connection() });
    const events = new QueueEvents("kb-sync", { connection: connection() });
    await events.waitUntilReady();
    const job = await queue.add("resync", {});
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(/could not fetch/);
    expect(logs.find((l) => l["msg"] === "job failed" && l["jobId"] === job.id)).toMatchObject({
      code: "source_fetch_failed",
      level: "error",
    });
    await running.close();
    await Promise.all([queue.close(), events.close()]);
  });

  test("close waits for a job in flight", async () => {
    let finished = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // The processor itself says when the job is in flight. Waiting for QueueEvents' "active" instead
    // missed the event when it fired before the events stream issued its first read, and the test
    // then hung until its timeout.
    let started!: () => void;
    const inFlight = new Promise<void>((r) => {
      started = r;
    });
    const running = startWorkers({
      redisUrl: url,
      queues: ["webhook"],
      processors: {
        webhook: async () => {
          started();
          await gate;
          finished = true;
        },
      },
      logger,
    });
    await running.ready();
    const queue = new Queue("webhook", { connection: connection() });
    await queue.add("deliver", {});
    await inFlight;
    const closing = running.close();
    release();
    await closing;
    expect(finished).toBe(true);
    await queue.close();
  });
});
