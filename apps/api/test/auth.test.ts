import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createAuthService } from "@wakeel/auth";
import { API_LIMITS as limits } from "@wakeel/config";
import { createDatabase, type Database } from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import { createLogger } from "@wakeel/telemetry";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type App, buildApp } from "../src/app";

/**
 * Task 1.2 acceptance against real Postgres (app_rw) and Redis: sign up, sign in, sign out; cookie
 * flags; the 6th failed sign-in in a minute is rate_limited; a mutation without the CSRF header is
 * rejected.
 */
const REDIS_IMAGE = "redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335";
const STUDIO = "https://studio.wakeel.test";
const SECRET = "test-only-auth-secret-0123456789abcdef";

let pgc: StartedTestDatabase;
let redisContainer: StartedRedisContainer;
let db: Database;
let redis: Redis;
let app: App;

beforeAll(async () => {
  [pgc, redisContainer] = await Promise.all([startTestDatabase(), new RedisContainer(REDIS_IMAGE).start()]);
  db = createDatabase({ url: pgc.urls.rw });
  redis = new Redis(redisContainer.getConnectionUrl(), { maxRetriesPerRequest: 1 });
  const service = createAuthService({
    db,
    redis,
    secret: SECRET,
    baseUrl: "https://api.wakeel.test",
    studioOrigin: STUDIO,
    signInFailuresPerMinute: limits.signInFailuresPerMinute,
  });
  app = buildApp({
    role: "all",
    logger: createLogger({ service: "api", level: "silent" }),
    studio: { auth: service, studioOrigin: STUDIO, db },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await Promise.allSettled([db?.close(), redis?.quit()]);
  await Promise.allSettled([pgc?.stop(), redisContainer?.stop()]);
});

let counter = 0;
const uniqueEmail = () => `user${Date.now()}${counter++}@example.test`;
const PASSWORD = "correct horse battery";

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: body as object, headers: { origin: STUDIO, ...headers } });

/** `name=value` pairs from Set-Cookie, as a browser would send them back. */
const cookieHeader = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c: string) => c.split(";")[0]).join("; ");
};

const signUp = async (email = uniqueEmail(), name = "إياد Test") => {
  const res = await post("/v1/auth/sign-up", { name, email, password: PASSWORD });
  expect(res.statusCode, res.body).toBe(201);
  return { res, email, cookie: cookieHeader(res), csrf: res.json().csrfToken as string };
};

describe("sign up", () => {
  test("creates the user, signs them in and sets a hardened session cookie", async () => {
    const { res, email } = await signUp();
    const body = res.json();
    expect(body.user).toMatchObject({ email, name: "إياد Test", emailVerified: false, locale: "en" });
    expect(body.user.id).toMatch(/^usr_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const raw = res.headers["set-cookie"];
    const cookies = (Array.isArray(raw) ? raw : [String(raw)]).filter((c) => c.includes("session_token="));
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0] ?? "";
    expect(cookie).toMatch(/^__Secure-wakeel\.session_token=/);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  test("stores a password hash in accounts, never the password", async () => {
    const { email } = await signUp();
    const rows = await superuserQuery(
      pgc.urls,
      "select a.id, a.provider_id, a.password from accounts a join users u on u.id = a.user_id where u.email = $1",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["id"]).toMatch(/^acc_/);
    expect(rows[0]?.["provider_id"]).toBe("credential");
    const hash = String(rows[0]?.["password"]);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.length).toBeGreaterThan(40);
    const sessions = await superuserQuery(
      pgc.urls,
      "select s.id from sessions s join users u on u.id = s.user_id where u.email = $1",
      [email],
    );
    expect(sessions[0]?.["id"]).toMatch(/^ses_/);
  });

  test("an email that is taken, in any case, is email_taken", async () => {
    const { email } = await signUp();
    const res = await post("/v1/auth/sign-up", { name: "Again", email: email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("email_taken");
  });

  test("a short password is validation_failed on the password field", async () => {
    const res = await post("/v1/auth/sign-up", { name: "X", email: uniqueEmail(), password: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "validation_failed", errors: [{ path: "password" }] });
  });
});

describe("sign in", () => {
  test("with the right password returns a session; the cookie reads it back", async () => {
    const { email } = await signUp();
    const res = await post("/v1/auth/sign-in", { email, password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    const session = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: cookieHeader(res) },
    });
    expect(session.statusCode).toBe(200);
    expect(session.headers["cache-control"]).toBe("no-store");
    expect(session.json().user.email).toBe(email);
    expect(session.json().csrfToken).toBe(res.json().csrfToken);
  });

  test("with a wrong password is invalid_credentials, and so is an unknown email", async () => {
    const { email } = await signUp();
    for (const body of [
      { email, password: "wrong password" },
      { email: uniqueEmail(), password: PASSWORD },
    ]) {
      const res = await post("/v1/auth/sign-in", body);
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("invalid_credentials");
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  test("the 6th failed sign-in in a minute is rate_limited, even with the right password", async () => {
    const { email } = await signUp();
    for (let i = 0; i < limits.signInFailuresPerMinute; i++) {
      const res = await post("/v1/auth/sign-in", { email, password: `wrong ${i}` });
      expect(res.json().code).toBe("invalid_credentials");
    }
    const sixth = await post("/v1/auth/sign-in", { email, password: PASSWORD });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().code).toBe("rate_limited");
    expect(sixth.json().fix).toMatch(/Wait \d+ seconds/);
    // Another address is not affected.
    const other = await signUp();
    expect((await post("/v1/auth/sign-in", { email: other.email, password: PASSWORD })).statusCode).toBe(200);
  });

  test("a success clears earlier failures", async () => {
    const { email } = await signUp();
    for (let i = 0; i < limits.signInFailuresPerMinute - 1; i++) {
      await post("/v1/auth/sign-in", { email, password: "wrong" });
    }
    expect((await post("/v1/auth/sign-in", { email, password: PASSWORD })).statusCode).toBe(200);
    for (let i = 0; i < limits.signInFailuresPerMinute - 1; i++) {
      await post("/v1/auth/sign-in", { email, password: "wrong" });
    }
    expect((await post("/v1/auth/sign-in", { email, password: PASSWORD })).statusCode).toBe(200);
  });

  test.each([
    ["another origin", { origin: "https://evil.example" }],
    ["no origin", { origin: "" }],
  ])("from %s is csrf_failed", async (_name, headers) => {
    const { email } = await signUp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in",
      payload: { email, password: PASSWORD },
      headers: headers.origin === "" ? {} : headers,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("csrf_failed");
  });
});

describe("sign out and CSRF", () => {
  test("a mutation with the session cookie but no CSRF header is rejected", async () => {
    const { cookie } = await signUp();
    const res = await post("/v1/auth/sign-out", undefined, { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("csrf_failed");
    // Still signed in.
    expect((await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie } })).statusCode).toBe(200);
  });

  test("a CSRF token from another session is rejected", async () => {
    const one = await signUp();
    const two = await signUp();
    const res = await post("/v1/auth/sign-out", undefined, { cookie: one.cookie, "x-csrf-token": two.csrf });
    expect(res.json().code).toBe("csrf_failed");
  });

  test("a valid token from another origin is rejected", async () => {
    const { cookie, csrf } = await signUp();
    const res = await post("/v1/auth/sign-out", undefined, {
      cookie,
      "x-csrf-token": csrf,
      origin: "https://evil.example",
    });
    expect(res.json().code).toBe("csrf_failed");
  });

  test("with the token, sign out ends the session and clears the cookie", async () => {
    const { cookie, csrf } = await signUp();
    const res = await post("/v1/auth/sign-out", undefined, { cookie, "x-csrf-token": csrf });
    expect(res.statusCode, res.body).toBe(204);
    const cleared = [res.headers["set-cookie"]].flat().join("\n");
    expect(cleared).toMatch(/session_token=;.*Max-Age=0/i);
    const after = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { cookie } });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe("unauthenticated");
  });

  test("without a cookie, session is unauthenticated and sign-out is unauthenticated", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/auth/session" })).json().code).toBe("unauthenticated");
    expect((await post("/v1/auth/sign-out", undefined)).json().code).toBe("unauthenticated");
  });

  test("a forged cookie value is not a session", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: "__Secure-wakeel.session_token=forged.value" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("role bridge", () => {
  test("does not mount the auth routes", async () => {
    const bridge = buildApp({ role: "bridge", logger: createLogger({ service: "api", level: "silent" }) });
    const res = await bridge.inject({ method: "POST", url: "/v1/auth/sign-in", payload: {} });
    expect(res.statusCode).toBe(404);
    await bridge.close();
  });
});
