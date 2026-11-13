import { describe, expect, test } from "vitest";
import {
  apiEnv,
  ConfigError,
  commonEnv,
  databaseEnv,
  loadConfig,
  MASTER_KEY_BYTES,
  masterKeyEnv,
  QUEUE_NAMES,
  redisEnv,
  workerEnv,
} from "../src/index";

const key32 = Buffer.alloc(32, 7).toString("base64");

const fails = (fn: () => unknown, variable: string) => {
  expect(fn).toThrow(ConfigError);
  try {
    fn();
  } catch (e) {
    expect((e as ConfigError).problems.map((p) => p.variable)).toContain(variable);
  }
};

describe("common", () => {
  test("defaults", () => {
    expect(loadConfig(commonEnv, { env: {} })).toEqual({ nodeEnv: "development", logLevel: "info" });
  });
  test("rejects an unknown NODE_ENV", () => {
    fails(() => loadConfig(commonEnv, { env: { NODE_ENV: "prod" } }), "NODE_ENV");
  });
});

describe("database and redis", () => {
  test.each(["postgres://u:p@db:5432/wakeel", "postgresql://u:p@db/wakeel?sslmode=require"])("accepts %s", (url) => {
    expect(loadConfig(databaseEnv, { env: { DATABASE_URL: url } }).databaseUrl.reveal()).toBe(url);
  });
  test("rejects a non-Postgres URL", () => {
    fails(() => loadConfig(databaseEnv, { env: { DATABASE_URL: "mysql://u:p@db/wakeel" } }), "DATABASE_URL");
  });
  test.each(["redis://localhost:6379", "rediss://:pw@cache:6380/0"])("accepts %s", (url) => {
    expect(loadConfig(redisEnv, { env: { REDIS_URL: url } }).redisUrl.reveal()).toBe(url);
  });
  test("rejects a non-Redis URL", () => {
    fails(() => loadConfig(redisEnv, { env: { REDIS_URL: "http://localhost:6379" } }), "REDIS_URL");
  });
});

describe("MASTER_KEY", () => {
  test("decodes 32 bytes of base64", () => {
    const key = loadConfig(masterKeyEnv, { env: { MASTER_KEY: key32 } }).masterKey.reveal();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(MASTER_KEY_BYTES);
    expect(Buffer.from(key).toString("base64")).toBe(key32);
  });
  test.each([
    ["16 bytes", Buffer.alloc(16, 1).toString("base64")],
    ["33 bytes", Buffer.alloc(33, 1).toString("base64")],
    ["not base64", "this is not base64 at all, not even close!!"],
    ["hex", Buffer.alloc(32, 1).toString("hex")],
    ["base64url alphabet", Buffer.alloc(32, 251).toString("base64url")],
  ])("rejects %s", (_name, value) => {
    fails(() => loadConfig(masterKeyEnv, { env: { MASTER_KEY: value } }), "MASTER_KEY");
  });
  test("the error explains the format without showing the value", () => {
    try {
      loadConfig(masterKeyEnv, { env: { MASTER_KEY: "c2hvcnQ=" } });
    } catch (e) {
      expect((e as Error).message).toContain("MASTER_KEY is not valid. 32 random bytes encoded as base64");
      expect((e as Error).message).not.toContain("c2hvcnQ=");
    }
  });
});

describe("api", () => {
  test("defaults to every route on port 3000", () => {
    expect(loadConfig(apiEnv, { env: {} })).toEqual({ role: "all", port: 3000, host: "127.0.0.1" });
  });
  test.each(["studio", "bridge", "all"])("accepts ROLE=%s", (role) => {
    expect(loadConfig(apiEnv, { env: { ROLE: role } }).role).toBe(role);
  });
  test.each([
    ["ROLE", "admin"],
    ["PORT", "0"],
    ["PORT", "70000"],
    ["PORT", "3000.5"],
  ])("rejects %s=%s", (name, v) => {
    fails(() => loadConfig(apiEnv, { env: { [name]: v } }), name);
  });
});

describe("worker", () => {
  test("consumes every queue by default", () => {
    expect(loadConfig(workerEnv, { env: {} }).queues).toEqual([...QUEUE_NAMES]);
  });
  test("parses a comma-separated list, trimming spaces and repeats", () => {
    expect(loadConfig(workerEnv, { env: { QUEUES: " turn, webhook ,turn" } }).queues).toEqual(["turn", "webhook"]);
  });
  test("rejects an unknown queue and names it", () => {
    try {
      loadConfig(workerEnv, { env: { QUEUES: "turn,emails" } });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/QUEUES is not valid: .*emails/);
    }
  });
  test("rejects an empty list", () => {
    fails(() => loadConfig(workerEnv, { env: { QUEUES: " , " } }), "QUEUES");
  });
});

test("groups compose into one service spec", () => {
  const config = loadConfig(
    { ...commonEnv, ...databaseEnv, ...redisEnv, ...apiEnv },
    { env: { DATABASE_URL: "postgres://u:p@db/w", REDIS_URL: "redis://cache:6379", ROLE: "bridge" } },
  );
  expect(config.role).toBe("bridge");
  expect(config.nodeEnv).toBe("development");
});
