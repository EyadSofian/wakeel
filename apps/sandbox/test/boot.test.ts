import { describe, expect, test } from "vitest";
import { runtimeProblem } from "../src/boot";

/** Architecture §5.3, layer 3: production boot refuses an unverified container runtime. */
describe("the production runtime check", () => {
  test("production without SANDBOX_RUNTIME_VERIFIED=1 refuses to start, and says how to fix it", () => {
    const problem = runtimeProblem({ nodeEnv: "production", sandboxRuntimeVerified: false });
    expect(problem).toMatch(/SANDBOX_RUNTIME_VERIFIED=1/);
    expect(problem).toMatch(/gVisor|runsc/);
  });

  test("production with the flag starts", () => {
    expect(runtimeProblem({ nodeEnv: "production", sandboxRuntimeVerified: true })).toBeUndefined();
  });

  test.each(["development", "test"] as const)("%s starts without the flag", (nodeEnv) => {
    expect(runtimeProblem({ nodeEnv, sandboxRuntimeVerified: false })).toBeUndefined();
  });
});
