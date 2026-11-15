import * as contracts from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { BRAND } from "../src/brand";
import {
  API_LIMITS,
  EGRESS_LIMITS,
  LIMITS,
  PLAN_DEFAULTS,
  STATE_MAX_BYTES,
  TABLE_LIMITS,
  WEBHOOK_LIMITS,
} from "../src/limits";

describe("limits", () => {
  test("engine limits are the contract values, not a copy that can drift", () => {
    expect(LIMITS).toBe(contracts.LIMITS);
    expect(TABLE_LIMITS).toBe(contracts.TABLE_LIMITS);
    expect(STATE_MAX_BYTES).toBe(contracts.STATE_MAX_BYTES);
  });

  test("the documented engine defaults (architecture §4)", () => {
    expect(LIMITS).toMatchObject({
      stepsPerTurn: 200,
      nodeVisitsPerTurn: 25,
      stackDepth: 16,
      turnSeconds: 120,
      codeMs: 10_000,
      codeMemoryMb: 64,
      autonomyIterations: 6,
      inboundTextBytes: 16 * 1024,
    });
    expect(STATE_MAX_BYTES).toBe(256 * 1024);
  });

  test("plan defaults agree with the table contract", () => {
    expect(PLAN_DEFAULTS.columnsPerTable).toBe(TABLE_LIMITS.columns);
    expect(PLAN_DEFAULTS.rowBytes).toBe(TABLE_LIMITS.rowBytes);
  });

  test("the sync wait stays under common 60 s proxy timeouts", () => {
    expect(API_LIMITS.waitSecondsMax).toBeLessThan(60);
    expect(API_LIMITS.pageSizeDefault).toBeLessThanOrEqual(API_LIMITS.pageSizeMax);
  });

  test("webhook retries match the schedule in the contract", () => {
    expect(WEBHOOK_LIMITS.retrySeconds).toBe(contracts.RETRY_SCHEDULE_SECONDS);
  });
});

describe("egress limits", () => {
  test("are the guest fetch limits from architecture §5.2", () => {
    expect(EGRESS_LIMITS.timeoutMs).toBe(10_000);
    expect(EGRESS_LIMITS.responseBytes).toBe(5 * 1024 * 1024);
    expect(EGRESS_LIMITS.redirects).toBe(5);
    expect(EGRESS_LIMITS.timeoutMs).toBe(LIMITS.fetchTimeoutMs);
  });
});

describe("brand", () => {
  test("has a name and the code name used for packages", () => {
    expect(BRAND.name.length).toBeGreaterThan(0);
    expect(BRAND.codeName).toBe("wakeel");
  });
});
