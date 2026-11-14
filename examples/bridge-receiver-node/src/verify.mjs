import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received (a string or Buffer), before JSON.parse.
export function verifyWakeel(header, rawBody, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = String(header ?? "").split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return signatures.some((s) => {
    const given = Buffer.from(s ?? "", "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
