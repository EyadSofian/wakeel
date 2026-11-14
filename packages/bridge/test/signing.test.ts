import { readFileSync } from "node:fs";
import { SIGNATURE_TOLERANCE_SECONDS } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  computeSignature,
  endRotation,
  generateSigningSecret,
  MAX_ACTIVE_SIGNING_SECRETS,
  parseSignatureHeader,
  rotateSigningSecrets,
  SIGNING_SECRET_PREFIX,
  signatureHeader,
  verifySignature,
} from "../src/signing";

/**
 * Task 5.1 (architecture §9.2, ADR-005, threat T6). The vector is read from the OpenAPI description
 * itself so the contract and the implementation cannot drift apart.
 */
const openapi = readFileSync(new URL("../../../docs/04-contracts/bridge-api.openapi.yaml", import.meta.url), "utf8");
const vectorMatch = /Test vector: secret `([^`]+)`, `t=(\d+)`, body `([^`]+)`\s*\n\s*→ `v1=([0-9a-f]{64})`/u.exec(
  openapi,
);
if (!vectorMatch) throw new Error("The test vector is missing from bridge-api.openapi.yaml");
const [, VECTOR_SECRET = "", vectorT = "", VECTOR_BODY = "", VECTOR_V1 = ""] = vectorMatch;
const VECTOR_T = Number(vectorT);

const ARABIC_BODY = JSON.stringify({ text: "طلبك رقم 5678 اتشحن امبارح - order shipped ✓" });

describe("the OpenAPI test vector", () => {
  test("is what the description says", () => {
    expect(VECTOR_SECRET).toBe("whsec_test_0123456789abcdef");
    expect(VECTOR_T).toBe(1_794_567_890);
    expect(VECTOR_BODY).toBe('{"hello":"world"}');
  });

  test("computeSignature reproduces it", () => {
    expect(computeSignature(VECTOR_SECRET, VECTOR_T, VECTOR_BODY)).toBe(VECTOR_V1);
  });

  test("signatureHeader produces the header in the delivery example", () => {
    const header = signatureHeader([VECTOR_SECRET], VECTOR_T, VECTOR_BODY);
    expect(header).toBe(`t=${VECTOR_T},v1=${VECTOR_V1}`);
    expect(openapi).toContain(`example: "${header}"`);
  });

  test("verifySignature accepts it", () => {
    const result = verifySignature({
      header: `t=${VECTOR_T},v1=${VECTOR_V1}`,
      rawBody: VECTOR_BODY,
      secrets: [VECTOR_SECRET],
      nowSeconds: VECTOR_T,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("computeSignature", () => {
  test("signs the exact bytes: a string body and its UTF-8 bytes give the same value", () => {
    const fromString = computeSignature(VECTOR_SECRET, VECTOR_T, ARABIC_BODY);
    const fromBytes = computeSignature(VECTOR_SECRET, VECTOR_T, new TextEncoder().encode(ARABIC_BODY));
    expect(fromBytes).toBe(fromString);
    expect(fromString).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("a different body, timestamp or secret changes the value", () => {
    const base = computeSignature(VECTOR_SECRET, VECTOR_T, VECTOR_BODY);
    expect(computeSignature(VECTOR_SECRET, VECTOR_T, '{"hello":"world" }')).not.toBe(base);
    expect(computeSignature(VECTOR_SECRET, VECTOR_T + 1, VECTOR_BODY)).not.toBe(base);
    expect(computeSignature(`${VECTOR_SECRET}x`, VECTOR_T, VECTOR_BODY)).not.toBe(base);
  });

  test.each([
    ["a negative timestamp", -1],
    ["a fractional timestamp", 1.5],
    ["NaN", Number.NaN],
  ])("rejects %s", (_name, t) => {
    expect(() => computeSignature(VECTOR_SECRET, t, VECTOR_BODY)).toThrow();
  });

  test("rejects an empty secret", () => {
    expect(() => computeSignature("", VECTOR_T, VECTOR_BODY)).toThrow();
  });
});

describe("verifySignature rejects", () => {
  const sign = (secret = VECTOR_SECRET, t = VECTOR_T, body = VECTOR_BODY) => signatureHeader([secret], t, body);
  const verify = (header: string, overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
    verifySignature({ header, rawBody: VECTOR_BODY, secrets: [VECTOR_SECRET], nowSeconds: VECTOR_T, ...overrides });

  test("a tampered body", () => {
    expect(verify(sign(), { rawBody: '{"hello":"World"}' })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("a tampered body in Arabic", () => {
    const header = sign(VECTOR_SECRET, VECTOR_T, ARABIC_BODY);
    expect(verify(header, { rawBody: ARABIC_BODY })).toEqual({ ok: true });
    expect(verify(header, { rawBody: ARABIC_BODY.replace("5678", "5679") })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  test("a wrong secret", () => {
    expect(verify(sign("whsec_someone_else"))).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("a timestamp older than the tolerance", () => {
    const t = VECTOR_T - SIGNATURE_TOLERANCE_SECONDS - 1;
    expect(verify(sign(VECTOR_SECRET, t))).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  test("a timestamp further in the future than the tolerance", () => {
    const t = VECTOR_T + SIGNATURE_TOLERANCE_SECONDS + 1;
    expect(verify(sign(VECTOR_SECRET, t))).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  test("a replayed header whose timestamp was changed to look fresh", () => {
    const old = VECTOR_T - 3_600;
    const header = sign(VECTOR_SECRET, old).replace(`t=${old}`, `t=${VECTOR_T}`);
    expect(verify(header)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("with a custom tolerance", () => {
    expect(verify(sign(VECTOR_SECRET, VECTOR_T - 61), { toleranceSeconds: 60 })).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
  });

  test("when no secret is configured", () => {
    expect(verify(sign(), { secrets: [] })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test.each([
    ["an empty header", ""],
    ["no timestamp", `v1=${VECTOR_V1}`],
    ["no v1 value", `t=${VECTOR_T}`],
    ["two timestamps", `t=${VECTOR_T},t=${VECTOR_T},v1=${VECTOR_V1}`],
    ["a timestamp that is not a number", `t=17945e6,v1=${VECTOR_V1}`],
    ["a negative timestamp", `t=-1,v1=${VECTOR_V1}`],
    ["an item without a value", `t=${VECTOR_T},v1`],
    ["only unknown schemes", `t=${VECTOR_T},v0=${VECTOR_V1}`],
  ])("a malformed header: %s", (_name, header) => {
    expect(verify(header)).toEqual({ ok: false, reason: "malformed_header" });
  });

  test.each([
    ["uppercase hex", VECTOR_V1.toUpperCase()],
    ["a short value", VECTOR_V1.slice(0, 63)],
    ["a long value", `${VECTOR_V1}00`],
    ["non-hex characters", `${VECTOR_V1.slice(0, 63)}g`],
  ])("a v1 value with %s", (_name, v1) => {
    expect(verify(`t=${VECTOR_T},v1=${v1}`)).toEqual({ ok: false, reason: "signature_mismatch" });
  });
});

describe("verifySignature accepts", () => {
  test("a timestamp exactly at the tolerance, in both directions", () => {
    for (const t of [VECTOR_T - SIGNATURE_TOLERANCE_SECONDS, VECTOR_T + SIGNATURE_TOLERANCE_SECONDS]) {
      const header = signatureHeader([VECTOR_SECRET], t, VECTOR_BODY);
      expect(verifySignature({ header, rawBody: VECTOR_BODY, secrets: [VECTOR_SECRET], nowSeconds: VECTOR_T })).toEqual(
        { ok: true },
      );
    }
  });

  test("spaces around items and an unknown scheme next to v1", () => {
    const header = ` t=${VECTOR_T} , v0=abc , v1=${VECTOR_V1} `;
    expect(verifySignature({ header, rawBody: VECTOR_BODY, secrets: [VECTOR_SECRET], nowSeconds: VECTOR_T })).toEqual({
      ok: true,
    });
  });

  test("a body given as bytes", () => {
    const header = signatureHeader([VECTOR_SECRET], VECTOR_T, ARABIC_BODY);
    const rawBody = new TextEncoder().encode(ARABIC_BODY);
    expect(verifySignature({ header, rawBody, secrets: [VECTOR_SECRET], nowSeconds: VECTOR_T })).toEqual({
      ok: true,
    });
  });
});

describe("parseSignatureHeader", () => {
  test("returns the timestamp and every v1 value in order", () => {
    expect(parseSignatureHeader(`t=${VECTOR_T},v1=aa,v1=bb`)).toEqual({
      timestamp: VECTOR_T,
      signatures: ["aa", "bb"],
    });
  });

  test("returns undefined for a malformed header", () => {
    expect(parseSignatureHeader("nonsense")).toBeUndefined();
  });
});

describe("signatureHeader", () => {
  test(`refuses no secrets and more than ${MAX_ACTIVE_SIGNING_SECRETS}`, () => {
    expect(() => signatureHeader([], VECTOR_T, VECTOR_BODY)).toThrow();
    const three = [generateSigningSecret(), generateSigningSecret(), generateSigningSecret()];
    expect(() => signatureHeader(three, VECTOR_T, VECTOR_BODY)).toThrow();
  });

  test("never contains a secret, and its errors never name one", () => {
    const secret = generateSigningSecret();
    expect(signatureHeader([secret], VECTOR_T, VECTOR_BODY)).not.toContain(secret);
    try {
      signatureHeader([secret, secret, secret], VECTOR_T, VECTOR_BODY);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(secret);
      expect(JSON.stringify(e)).not.toContain(secret);
    }
  });
});

describe("secret generation", () => {
  test("secrets carry the prefix and 32 random bytes", () => {
    const secret = generateSigningSecret();
    expect(secret.startsWith(SIGNING_SECRET_PREFIX)).toBe(true);
    const random = Buffer.from(secret.slice(SIGNING_SECRET_PREFIX.length), "base64url");
    expect(random.length).toBe(32);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/u);
  });

  test("every secret is different", () => {
    const secrets = new Set(Array.from({ length: 200 }, generateSigningSecret));
    expect(secrets.size).toBe(200);
  });
});

describe("rotation: two active secrets", () => {
  const body = ARABIC_BODY;
  const t = VECTOR_T;
  const verifyWith = (header: string, secret: string) =>
    verifySignature({ header, rawBody: body, secrets: [secret], nowSeconds: t });

  test("rotating puts the new secret first and keeps the old one", () => {
    const old = generateSigningSecret();
    const { secrets, created } = rotateSigningSecrets([old]);
    expect(secrets).toEqual([created, old]);
    expect(created).not.toBe(old);
  });

  test("while rotating the header carries two v1 values, and a receiver on either secret verifies", () => {
    const old = generateSigningSecret();
    const { secrets, created } = rotateSigningSecrets([old]);
    const header = signatureHeader(secrets, t, body);

    expect(parseSignatureHeader(header)?.signatures).toEqual([
      computeSignature(created, t, body),
      computeSignature(old, t, body),
    ]);
    expect(verifyWith(header, old)).toEqual({ ok: true });
    expect(verifyWith(header, created)).toEqual({ ok: true });
    expect(verifySignature({ header, rawBody: body, secrets: [created, old], nowSeconds: t })).toEqual({ ok: true });
    expect(verifyWith(header, generateSigningSecret())).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("a receiver holding both secrets accepts a header signed with either one", () => {
    const old = generateSigningSecret();
    const { secrets, created } = rotateSigningSecrets([old]);
    for (const signer of [old, created]) {
      const header = signatureHeader([signer], t, body);
      expect(verifySignature({ header, rawBody: body, secrets, nowSeconds: t })).toEqual({ ok: true });
    }
  });

  test("ending the rotation keeps only the newest; the old secret stops verifying", () => {
    const old = generateSigningSecret();
    const { secrets, created } = rotateSigningSecrets([old]);
    const after = endRotation(secrets);
    expect(after).toEqual([created]);

    const header = signatureHeader(after, t, body);
    expect(parseSignatureHeader(header)?.signatures).toHaveLength(1);
    expect(verifyWith(header, created)).toEqual({ ok: true });
    expect(verifyWith(header, old)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  test("rotating again during a rotation keeps two: the new one and the previous newest", () => {
    const first = generateSigningSecret();
    const second = rotateSigningSecrets([first]);
    const third = rotateSigningSecrets(second.secrets);
    expect(third.secrets).toEqual([third.created, second.created]);
    expect(third.secrets).toHaveLength(MAX_ACTIVE_SIGNING_SECRETS);
  });

  test("a connection with no secret yet gets its first one", () => {
    const { secrets, created } = rotateSigningSecrets([]);
    expect(secrets).toEqual([created]);
  });

  test("ending a rotation with nothing to end is a no-op, and an empty list is refused", () => {
    const only = generateSigningSecret();
    expect(endRotation([only])).toEqual([only]);
    expect(() => endRotation([])).toThrow();
  });

  test("rotation does not mutate its input", () => {
    const input = [generateSigningSecret()];
    const copy = [...input];
    rotateSigningSecrets(input);
    endRotation(input);
    expect(input).toEqual(copy);
  });
});
