import { createHmac, timingSafeEqual } from "node:crypto";

/** Seconds a signed webhook stays valid either side of now (chatwoot-adapter-spec §4). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies `X-Wakeel-Signature: t=<unix>,v1=<hex>[,v1=<hex>]` over the raw body with any of the active
 * secrets. Constant-time compare; every `v1` value is tried so a rotation never drops deliveries.
 */
export function verifySignature(
  header: string | undefined,
  rawBody: Buffer,
  secrets: readonly string[],
  nowSeconds: number,
): boolean {
  const parts = String(header ?? "")
    .split(",")
    .map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const given = parts.filter(([k]) => k === "v1").map(([, v]) => Buffer.from(v ?? "", "hex"));
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
    return given.some((g) => g.length === expected.length && timingSafeEqual(g, expected));
  });
}

/** Builds a header the way the platform does; used by tests and the local smoke script. */
export function signBody(rawBody: Buffer, secret: string, nowSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${nowSeconds}.`).update(rawBody).digest("hex");
  return `t=${nowSeconds},v1=${v1}`;
}
