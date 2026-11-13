import { describe, expect, test } from "vitest";
import { AppError, ERRORS, formatPath, newRequestId, REQUEST_ID_PATTERN } from "../src/index";

describe("AppError", () => {
  test("takes title, fix and status from errors.ts with placeholders filled", () => {
    const e = new AppError("rate_limited", { retryAfter: 30 });
    expect(e.status).toBe(429);
    expect(e.title).toBe("Too many requests");
    expect(e.fix).toBe("Wait 30 seconds and try again.");
    expect(e.message).toBe(e.title);
    expect(e).toBeInstanceOf(Error);
  });

  test("keeps detail, field errors and cause", () => {
    const cause = new Error("db down");
    const e = new AppError(
      "validation_failed",
      {},
      { detail: "d", errors: [{ path: "a", code: "x", message: "m" }], cause },
    );
    expect(e.detail).toBe("d");
    expect(e.errors).toHaveLength(1);
    expect(e.cause).toBe(cause);
  });

  test("every catalogue entry builds", () => {
    for (const code of Object.keys(ERRORS) as (keyof typeof ERRORS)[]) {
      expect(new AppError(code).status).toBe(ERRORS[code].status);
    }
  });
});

describe("formatPath", () => {
  test.each([
    [[], ""],
    [["message", "text"], "message.text"],
    [["nodes", 3, "cards", 0, "text"], "nodes[3].cards[0].text"],
    [[0, "sku"], "[0].sku"],
  ])("%j → %s", (path, expected) => {
    expect(formatPath(path)).toBe(expected);
  });
});

test("request ids are req_ ULIDs", () => {
  expect(newRequestId()).toMatch(REQUEST_ID_PATTERN);
  expect(newRequestId({ now: 0 }).slice(0, 14)).toBe("req_0000000000");
});
