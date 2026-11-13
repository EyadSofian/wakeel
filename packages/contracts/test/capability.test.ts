import { describe, expect, test } from "vitest";
import { CAPABILITY_TOKEN_PREFIX, mintCapabilityToken, verifyCapabilityToken } from "../src/capability";

/** The exec capability token (ADR-023 §4): minted by the worker, checked by egress. */

const KEY = "capability-key-for-tests-0123456789abcdef";
const OTHER_KEY = "another-capability-key-0123456789abcdefgh";
const claims = { ws: "ws_01jcqz5p6q7r8s9t0v1w2x3y4z", exec: "exec_01", exp: 2_000_000_000 };
const now = 1_900_000_000;

describe("capability tokens", () => {
  test("a minted token verifies and gives back its claims", async () => {
    const token = await mintCapabilityToken(KEY, claims);
    expect(token.startsWith(`${CAPABILITY_TOKEN_PREFIX}.`)).toBe(true);
    expect(token.split(".")).toHaveLength(3);
    expect(await verifyCapabilityToken(KEY, token, now)).toEqual(claims);
  });

  test("another key does not verify it", async () => {
    const token = await mintCapabilityToken(KEY, claims);
    expect(await verifyCapabilityToken(OTHER_KEY, token, now)).toBeUndefined();
  });

  test("an expired token does not verify", async () => {
    const token = await mintCapabilityToken(KEY, claims);
    expect(await verifyCapabilityToken(KEY, token, claims.exp)).toBeUndefined();
    expect(await verifyCapabilityToken(KEY, token, claims.exp + 1)).toBeUndefined();
  });

  test("a changed payload does not verify", async () => {
    const token = await mintCapabilityToken(KEY, claims);
    const [prefix, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, ws: "ws_01jcqz5p6q7r8s9t0v1w2x3y5a" })).toString(
      "base64url",
    );
    expect(await verifyCapabilityToken(KEY, `${prefix}.${forged}.${signature}`, now)).toBeUndefined();
  });

  test.each([
    ["empty", ""],
    ["no dots", "wkc1"],
    ["wrong prefix", "wkc2.e30.AAAA"],
    ["four parts", "wkc1.e30.AAAA.AAAA"],
    ["payload not JSON", `wkc1.${Buffer.from("nope").toString("base64url")}.AAAA`],
    ["signature not base64url", "wkc1.e30.***"],
  ])("a malformed token (%s) does not verify", async (_name, token) => {
    expect(await verifyCapabilityToken(KEY, token, now)).toBeUndefined();
  });

  test("a correctly signed token with invalid claims does not verify", async () => {
    // Signed with the right key but naming no valid workspace: the claims are checked after the signature.
    const token = await mintCapabilityToken(KEY, { ...claims, ws: "not-a-workspace" } as typeof claims).catch(
      () => undefined,
    );
    expect(token).toBeUndefined();
  });

  test("keys shorter than 32 characters are refused", async () => {
    await expect(mintCapabilityToken("short", claims)).rejects.toThrow();
    await expect(verifyCapabilityToken("short", "wkc1.e30.AAAA", now)).rejects.toThrow();
  });
});
