import { Writable } from "node:stream";
import { AppError, Problem, REQUEST_ID_PATTERN } from "@wakeel/contracts";
import { createLogger } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { type App, buildApp } from "../src/app";

/** Integration at the HTTP boundary (Fastify inject: real routing, hooks and serialisation). */
const logs: Record<string, unknown>[] = [];
const logger = createLogger({
  service: "api",
  level: "debug",
  destination: new Writable({
    write(chunk, _e, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) logs.push(JSON.parse(line));
      done();
    },
  }),
});

let app: App;

beforeAll(async () => {
  app = buildApp({ role: "all", logger });
  const Body = z.object({
    message: z.object({ type: z.literal("text"), text: z.string().min(1) }),
    items: z.array(z.object({ qty: z.number().int().positive() })),
  });
  app.post("/test/zod", async (request) => Body.parse(request.body));
  app.get("/test/app-error", async () => {
    throw new AppError("rate_limited", { retryAfter: 12 }, { detail: "Bucket empty for this key." });
  });
  app.get("/test/crash", async () => {
    throw new Error("connection to 10.0.0.5 refused: password=hunter2");
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const problemOf = (body: string) => Problem.parse(JSON.parse(body));

describe("problem documents (acceptance 0.9)", () => {
  test("an unknown route returns a not_found problem", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    const problem = problemOf(res.body);
    expect(problem).toMatchObject({
      code: "not_found",
      status: 404,
      title: "We could not find that",
      fix: "Check the id, or it may have been deleted.",
      type: expect.stringMatching(/\/errors\/not_found$/),
    });
    expect(problem.requestId).toMatch(REQUEST_ID_PATTERN);
    expect(res.headers["x-request-id"]).toBe(problem.requestId);
  });

  test("a thrown zod error returns validation_failed with paths", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/zod",
      payload: { message: { type: "text", text: "" }, items: [{ qty: 1 }, { qty: -2 }] },
    });
    expect(res.statusCode).toBe(400);
    const problem = problemOf(res.body);
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors?.map((e) => e.path)).toEqual(["message.text", "items[1].qty"]);
    expect(problem.errors?.[0]).toMatchObject({ code: "too_small" });
  });
});

describe("other failures", () => {
  test("an AppError keeps its status, filled title and fix, and detail", async () => {
    const problem = problemOf((await app.inject({ method: "GET", url: "/test/app-error" })).body);
    expect(problem).toMatchObject({
      status: 429,
      code: "rate_limited",
      title: "Too many requests",
      fix: "Wait 12 seconds and try again.",
      detail: "Bucket empty for this key.",
    });
  });

  test("an unexpected error is internal_error and its message stays out of the response", async () => {
    const res = await app.inject({ method: "GET", url: "/test/crash" });
    expect(res.statusCode).toBe(500);
    const problem = problemOf(res.body);
    expect(problem.code).toBe("internal_error");
    expect(problem.fix).toContain(problem.requestId);
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("10.0.0.5");
    // The log has the cause, tagged with the same request id.
    const logged = logs.find((l) => l["msg"] === "request failed" && l["reqId"] === problem.requestId);
    expect(logged).toBeDefined();
  });

  test("malformed JSON is validation_failed, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/zod",
      headers: { "content-type": "application/json" },
      payload: '{"message": ',
    });
    expect(res.statusCode).toBe(400);
    expect(problemOf(res.body).code).toBe("validation_failed");
  });

  test("a body over the limit is payload_too_large", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/zod",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ blob: "x".repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(problemOf(res.body).code).toBe("payload_too_large");
  });

  test("a wrong method on a known path is not_found", async () => {
    const res = await app.inject({ method: "DELETE", url: "/health/live" });
    expect(problemOf(res.body).code).toBe("not_found");
  });
});

describe("request ids", () => {
  test("a valid incoming X-Request-Id is kept", async () => {
    const id = "req_01m7a256m0xb4g5v3v7remeqyf";
    const res = await app.inject({ method: "GET", url: "/health/live", headers: { "x-request-id": id } });
    expect(res.headers["x-request-id"]).toBe(id);
  });

  test.each(["anything", "req_short", "<script>"])("an invalid incoming id %j is replaced", async (bad) => {
    const res = await app.inject({ method: "GET", url: "/health/live", headers: { "x-request-id": bad } });
    expect(res.headers["x-request-id"]).not.toBe(bad);
    expect(res.headers["x-request-id"]).toMatch(REQUEST_ID_PATTERN);
  });
});

describe("health", () => {
  test("live is always ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.json()).toEqual({ status: "ok" });
  });

  test("ready reports each check and 503 when one fails, without details", async () => {
    const probe = buildApp({
      role: "bridge",
      logger,
      readinessTimeoutMs: 50,
      readiness: {
        database: async () => undefined,
        redis: async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:6379 secret-ish detail");
        },
        slow: () => new Promise(() => undefined),
      },
    });
    const res = await probe.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", checks: { database: "ok", redis: "failed", slow: "failed" } });
    expect(res.body).not.toContain("ECONNREFUSED");
    await probe.close();
  });
});
