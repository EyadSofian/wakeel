import { expect, test } from "vitest";
import { NewUsage } from "../src/usage";

test("usage defaults and traffic modes are explicit", () => {
  expect(NewUsage.parse({ kind: "llm_tokens", quantity: 12, unit: "tokens", mode: "eval" })).toEqual({
    kind: "llm_tokens",
    quantity: 12,
    unit: "tokens",
    mode: "eval",
    costMicroUsd: 0,
    detail: {},
  });
  for (const invalid of [
    { kind: "unknown" },
    { quantity: -1 },
    { quantity: Number.POSITIVE_INFINITY },
    { mode: "test" },
    { costMicroUsd: 1.5 },
    { unit: "bytes" },
  ]) {
    expect(
      NewUsage.safeParse({ kind: "llm_tokens", quantity: 12, unit: "tokens", mode: "live", ...invalid }).success,
    ).toBe(false);
  }
});
