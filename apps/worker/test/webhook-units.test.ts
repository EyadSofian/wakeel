import { RETRY_SCHEDULE_SECONDS } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { retryAt } from "../src/webhook/index";

/** Task 5.2: the retry schedule (architecture §9.2). The sender's tests live in packages/bridge. */

const T0 = new Date("2026-11-14T10:00:00.000Z");

describe("retryAt", () => {
  test.each(RETRY_SCHEDULE_SECONDS.map((s, i) => [i + 1, s] as const))(
    "after failed attempt %i the next is due %is later, ±20%",
    (attempt, seconds) => {
      const low = retryAt(attempt, T0, () => 0);
      const mid = retryAt(attempt, T0, () => 0.5);
      const high = retryAt(attempt, T0, () => 0.999_999);
      expect(mid?.getTime()).toBe(T0.getTime() + seconds * 1000);
      expect(low?.getTime()).toBe(T0.getTime() + seconds * 800);
      expect((high?.getTime() ?? 0) - T0.getTime()).toBeLessThanOrEqual(seconds * 1200);
      expect((high?.getTime() ?? 0) - T0.getTime()).toBeGreaterThan(seconds * 1199);
    },
  );

  test("after the 9th failed attempt there is none: the event is dead", () => {
    expect(RETRY_SCHEDULE_SECONDS).toHaveLength(8);
    expect(retryAt(9, T0, () => 0.5)).toBeUndefined();
    expect(retryAt(12, T0, () => 0.5)).toBeUndefined();
  });
});
