import { availableParallelism } from "node:os";
import { LIMITS } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig, SANDBOX_LIMITS, sandboxEnv } from "../src/index";

const problemsFor = (env: Record<string, string>) => {
  try {
    loadConfig(sandboxEnv, { env });
  } catch (e) {
    return (e as ConfigError).problems.map((p) => p.variable);
  }
  return [];
};

describe("sandbox env", () => {
  test("defaults: loopback, port 4300, two runtimes per core", () => {
    expect(loadConfig(sandboxEnv, { env: {} })).toEqual({
      sandboxHost: "127.0.0.1",
      sandboxPort: 4300,
      sandboxPoolSize: availableParallelism() * 2,
    });
  });

  test("reads every variable", () => {
    const config = loadConfig(sandboxEnv, {
      env: { SANDBOX_HOST: "0.0.0.0", SANDBOX_PORT: "4301", SANDBOX_POOL_SIZE: "3" },
    });
    expect(config).toEqual({ sandboxHost: "0.0.0.0", sandboxPort: 4301, sandboxPoolSize: 3 });
  });

  test.each([
    ["SANDBOX_PORT", "0"],
    ["SANDBOX_PORT", "70000"],
    ["SANDBOX_POOL_SIZE", "0"],
    ["SANDBOX_POOL_SIZE", "two"],
  ])("rejects %s=%s", (variable, value) => {
    expect(() => loadConfig(sandboxEnv, { env: { [variable]: value } })).toThrow(ConfigError);
    expect(problemsFor({ [variable]: value })).toEqual([variable]);
  });
});

describe("sandbox limits", () => {
  test("defaults come from the engine limits and callers may only lower them", () => {
    expect(SANDBOX_LIMITS.defaultTimeoutMs).toBe(LIMITS.codeMs);
    expect(SANDBOX_LIMITS.maxMemoryMb).toBe(LIMITS.codeMemoryMb);
    expect(SANDBOX_LIMITS.maxTimeoutMs).toBe(60_000);
    expect(SANDBOX_LIMITS.killGraceMs).toBe(250);
  });

  test("the thread stack is at least 32 times the interpreter stack", () => {
    // Below that ratio, deep native recursion inside QuickJS (JSON.parse of nested arrays) overflows
    // the host thread's stack before QuickJS's own check fires.
    expect(SANDBOX_LIMITS.threadStackMb * 1024 * 1024).toBeGreaterThanOrEqual(
      32 * SANDBOX_LIMITS.interpreterStackBytes,
    );
  });
});
