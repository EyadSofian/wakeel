import { describe, expect, test } from "vitest";
import { csrfTokenFor, verifyCsrfToken } from "../src/csrf";

describe("CSRF tokens", () => {
  const secret = "s".repeat(32);

  test("are stable for a session and differ between sessions and secrets", () => {
    expect(csrfTokenFor(secret, "token-a")).toBe(csrfTokenFor(secret, "token-a"));
    expect(csrfTokenFor(secret, "token-a")).not.toBe(csrfTokenFor(secret, "token-b"));
    expect(csrfTokenFor(secret, "token-a")).not.toBe(csrfTokenFor("t".repeat(32), "token-a"));
  });

  test("are URL-safe and do not contain the session token", () => {
    const token = csrfTokenFor(secret, "session-token-value");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain("session-token-value");
  });

  test.each([
    ["the right token", (t: string) => t, true],
    ["no token", () => undefined, false],
    ["an empty token", () => "", false],
    ["a truncated token", (t: string) => t.slice(0, -1), false],
    ["a token with one character changed", (t: string) => `${t.slice(0, -1)}${t.endsWith("A") ? "B" : "A"}`, false],
    ["the token of another session", () => csrfTokenFor(secret, "other"), false],
  ])("verify accepts only the right token: %s", (_name, make, ok) => {
    const right = csrfTokenFor(secret, "token-a");
    expect(verifyCsrfToken(secret, "token-a", make(right))).toBe(ok);
  });
});
