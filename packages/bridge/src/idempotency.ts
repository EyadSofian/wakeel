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

/**
 * The de-duplication key for a message sent with `externalMessageId` and no `Idempotency-Key`
 * (OpenAPI `SendMessageRequest.externalMessageId`, ADR-024). It is stored in the same per-connection
 * key column, so the conversation's external id is part of it: a channel's message ids are only
 * unique within a conversation. Hashed so two 255-character ids still fit the 255-character column.
 */
export function externalMessageKey(externalConversationId: string, externalMessageId: string): string {
  const digest = createHash("sha256")
    .update(`${externalConversationId.length}:${externalConversationId}\n${externalMessageId}`)
    .digest("base64url");
  return `xmid:${digest}`;
}
