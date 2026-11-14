import { describe, expect, test } from "vitest";
import { scrubSecrets } from "../src/turn/redact";

describe("scrubSecrets (task 7.3)", () => {
  test.each([
    ["a whole value", { a: "s3cr3t-value" }, { a: "[redacted]" }],
    ["inside a longer string", { a: "Bearer s3cr3t-value!" }, { a: "Bearer [redacted]!" }],
    ["in arrays and nested objects", [{ b: ["x s3cr3t-value y"] }], [{ b: ["x [redacted] y"] }]],
    ["in Arabic text", { a: "الرمز s3cr3t-value هنا" }, { a: "الرمز [redacted] هنا" }],
    ["numbers and nulls are left alone", { a: 1, b: null, c: true }, { a: 1, b: null, c: true }],
  ])("%s", (_name, input, expected) => {
    expect(scrubSecrets(input, ["s3cr3t-value"])).toEqual(expected);
  });

  test("the longer of two overlapping secrets is replaced first", () => {
    expect(scrubSecrets("abcd-efgh", ["abcd", "abcd-efgh"])).toBe("[redacted]");
  });

  test("secrets under 4 characters and an empty set change nothing", () => {
    expect(scrubSecrets({ a: "abc" }, ["abc"])).toEqual({ a: "abc" });
    const same = { a: "x" };
    expect(scrubSecrets(same, [])).toBe(same);
  });
});
