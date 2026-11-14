import { createHash } from "node:crypto";

/** JSON with object keys sorted, so the same body always hashes the same (§9.1 Idempotency-Key). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The fingerprint of a request stored with its idempotency key: the route and the parsed body. */
export function requestFingerprint(operation: string, body: unknown): string {
  return createHash("sha256")
    .update(`${operation}\n${canonicalJson(body)}`)
    .digest("hex");
}
