import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { DecryptError, type Keyring, open, rewrap, seal, validateKeyring } from "../src/crypto";

/** Task 1.5 acceptance: round-trip; wrong key fails; rotation re-wraps without changing plaintext. */
const key = (version: number) => ({ version, key: new Uint8Array(randomBytes(32)) });
const v1 = key(1);
const v2 = key(2);
const ring1: Keyring = { current: v1 };
const ring2: Keyring = { current: v2, previous: [v1] };
const AAD = "workspace_secrets:ws_01m7a256m0a13warwhczsjhx9g:anthropic.api_key";

const expectDecryptError = (fn: () => unknown) => expect(fn).toThrow(DecryptError);

describe("seal and open", () => {
  test.each([
    ["ASCII", "sk-ant-api03-abcdef"],
    ["Arabic and emoji", "مفتاح سري 🔑"],
    ["empty", ""],
    ["64 KB", "x".repeat(65_536)],
  ])("round-trips %s", (_name, value) => {
    const sealed = seal(ring1, value, AAD);
    expect(sealed.keyVersion).toBe(1);
    expect(open(ring1, sealed, AAD).toString("utf8")).toBe(value);
  });

  test("the ciphertext does not contain the plaintext and differs every time", () => {
    const a = seal(ring1, "sk-ant-api03-abcdef", AAD);
    const b = seal(ring1, "sk-ant-api03-abcdef", AAD);
    expect(a.ciphertext.includes(Buffer.from("sk-ant"))).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  test("a different master key fails", () => {
    const sealed = seal(ring1, "secret", AAD);
    expectDecryptError(() => open({ current: { version: 1, key: new Uint8Array(randomBytes(32)) } }, sealed, AAD));
  });

  test("a missing key version fails with a clear message", () => {
    const sealed = seal(ring2, "secret", AAD);
    expect(() => open(ring1, sealed, AAD)).toThrow(/No master key with version 2/);
  });

  test("a value moved to another row or tenant fails", () => {
    const sealed = seal(ring1, "secret", AAD);
    expectDecryptError(() => open(ring1, sealed, AAD.replace("anthropic", "openai")));
    expectDecryptError(() =>
      open(ring1, sealed, AAD.replace("ws_01m7a256m0a13warwhczsjhx9g", "ws_01m7a256m0a13warwhczsjhx9h")),
    );
  });

  test("a changed key_version fails even if that version exists", () => {
    const both: Keyring = { current: v1, previous: [v2] };
    const sealed = seal(both, "secret", AAD);
    expectDecryptError(() => open(both, { ...sealed, keyVersion: 2 }, AAD));
  });

  test("any flipped byte fails", () => {
    const sealed = seal(ring1, "a secret worth protecting", AAD);
    for (let i = 1; i < sealed.ciphertext.length; i += 7) {
      const tampered = Buffer.from(sealed.ciphertext);
      tampered[i] = (tampered[i] ?? 0) ^ 0x01;
      expectDecryptError(() => open(ring1, { ...sealed, ciphertext: tampered }, AAD));
    }
  });

  test("an unknown format or a truncated value fails", () => {
    const sealed = seal(ring1, "secret", AAD);
    const wrongFormat = Buffer.from(sealed.ciphertext);
    wrongFormat[0] = 9;
    expectDecryptError(() => open(ring1, { ...sealed, ciphertext: wrongFormat }, AAD));
    expectDecryptError(() => open(ring1, { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 40) }, AAD));
  });
});

describe("rotation", () => {
  test("re-wraps under the new key without changing the plaintext or the encrypted value", () => {
    const before = seal(ring1, "مفتاح قديم", AAD);
    const after = rewrap(ring2, before, AAD);
    expect(after.keyVersion).toBe(2);
    expect(open(ring2, after, AAD).toString("utf8")).toBe("مفتاح قديم");
    // Bytes after the wrapped data key (value nonce, tag and body) are identical.
    expect(after.ciphertext.subarray(61).equals(before.ciphertext.subarray(61))).toBe(true);
    expect(after.ciphertext.subarray(0, 61).equals(before.ciphertext.subarray(0, 61))).toBe(false);
  });

  test("after rotation the old key alone can no longer read it", () => {
    const after = rewrap(ring2, seal(ring1, "secret", AAD), AAD);
    expect(() => open(ring1, after, AAD)).toThrow(/No master key with version 2/);
  });

  test("the old ciphertext still opens while the previous key is configured", () => {
    const before = seal(ring1, "secret", AAD);
    expect(open(ring2, before, AAD).toString()).toBe("secret");
  });

  test("a value already on the current version is returned unchanged", () => {
    const sealed = seal(ring2, "secret", AAD);
    expect(rewrap(ring2, sealed, AAD)).toBe(sealed);
  });

  test("new values use the current version", () => {
    expect(seal(ring2, "secret", AAD).keyVersion).toBe(2);
  });
});

describe("validateKeyring", () => {
  test.each([
    ["a short key", { current: { version: 1, key: new Uint8Array(16) } }, /not 32 bytes/],
    ["version 0", { current: { version: 0, key: new Uint8Array(32) } }, /not valid/],
    ["a repeated version", { current: v1, previous: [{ ...v2, version: 1 }] }, /appears twice/],
  ])("rejects %s", (_name, ring, message) => {
    expect(() => validateKeyring(ring as Keyring)).toThrow(message);
  });

  test("accepts a current key with previous ones", () => {
    expect(() => validateKeyring(ring2)).not.toThrow();
  });
});
