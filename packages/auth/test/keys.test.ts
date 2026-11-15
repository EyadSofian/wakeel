import { describe, expect, test } from "vitest";
import { generateKey, hashSecret, KEY_SCOPES, parseKey, secretMatches } from "../src/keys";

describe("API keys", () => {
  test("a workspace key reads wk_live_<8>_<43> and parses back", () => {
    const k = generateKey("workspace");
    expect(k.key).toMatch(/^wk_live_[0-9a-z]{8}_[A-Za-z0-9_-]{43}$/);
    const parsed = parseKey(k.key);
    expect(parsed).toMatchObject({ kind: "workspace", prefix: k.prefix });
    expect(parsed && secretMatches(parsed.secret, k.secretHash)).toBe(true);
  });

  test("a bridge key uses its own marker", () => {
    expect(generateKey("bridge").key).toMatch(/^wk_bridge_/);
    expect(parseKey(generateKey("bridge").key)?.kind).toBe("bridge");
  });

  test("the stored hash is SHA-256 of the secret and does not contain the key", () => {
    const k = generateKey("workspace");
    const secret = k.key.split("_").slice(3).join("_");
    expect(k.secretHash).toBe(hashSecret(secret));
    expect(k.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.secretHash).not.toContain(secret);
  });

  test("keys are unique", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateKey("workspace").key));
    expect(keys.size).toBe(200);
  });

  test.each([
    "",
    "wk_live_",
    "wk_test_abcdefgh_" + "a".repeat(43),
    "wk_live_ABCDEFGH_" + "a".repeat(43),
    "wk_live_abcdefg_" + "a".repeat(43),
    "wk_live_abcdefgh_" + "a".repeat(42),
    "wk_live_abcdefgh_" + "a".repeat(43) + " ",
    "Bearer wk_live_abcdefgh_" + "a".repeat(43),
  ])("rejects %j", (value) => {
    expect(parseKey(value)).toBeUndefined();
  });

  test("a wrong secret does not match", () => {
    const k = generateKey("workspace");
    expect(secretMatches("x".repeat(43), k.secretHash)).toBe(false);
  });

  test("keys can never manage people, keys or secrets", () => {
    for (const s of KEY_SCOPES) expect(s).not.toMatch(/^(member\.(invite|update_role|remove)|api_key\.|secret\.)/);
    expect(KEY_SCOPES).toContain("bot.update");
    expect(KEY_SCOPES).toContain("workspace.read");
    expect(KEY_SCOPES).not.toContain("workspace.delete");
  });
});
