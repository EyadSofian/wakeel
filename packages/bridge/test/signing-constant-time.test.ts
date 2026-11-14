import { beforeEach, describe, expect, test, vi } from "vitest";

/** The v1 comparison must be constant time (OpenAPI "Verifying a webhook", step 4). */
const timingSafeEqual = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqual.calls++;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { signatureHeader, verifySignature } = await import("../src/signing");

describe("verifySignature", () => {
  beforeEach(() => {
    timingSafeEqual.calls = 0;
  });

  test("compares a matching value with timingSafeEqual", () => {
    const header = signatureHeader(["whsec_a"], 100, "{}");
    expect(verifySignature({ header, rawBody: "{}", secrets: ["whsec_a"], nowSeconds: 100 })).toEqual({ ok: true });
    expect(timingSafeEqual.calls).toBeGreaterThan(0);
  });

  test("compares a wrong value with timingSafeEqual, against every secret and every v1", () => {
    const header = signatureHeader(["whsec_a", "whsec_b"], 100, "{}");
    const result = verifySignature({ header, rawBody: "{}", secrets: ["whsec_c", "whsec_d"], nowSeconds: 100 });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
    expect(timingSafeEqual.calls).toBe(4);
  });
});
