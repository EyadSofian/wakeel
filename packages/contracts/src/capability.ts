import { z } from "zod";
import { WorkspaceId } from "./common";

/**
 * Exec capability tokens (ADR-023 §4, ADR-020 identity option b). The worker mints one per exec and
 * puts it in the sandbox exec frame; the sandbox passes it to egress unchanged; egress verifies it
 * and takes the workspace from it. Only the worker and egress hold the key.
 *
 * Format: `wkc1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(key, "wkc1.<payload>"))>`. WebCrypto
 * keeps this usable from any runtime; `crypto.subtle.verify` compares the MAC in constant time.
 */

export const CAPABILITY_TOKEN_PREFIX = "wkc1";

/** Keys shorter than this are refused: an HMAC key should carry at least 256 bits. */
const MIN_KEY_LENGTH = 32;
/** Generous for three base64url parts; anything longer is not a token we minted. */
const MAX_TOKEN_LENGTH = 2048;

export const CapabilityClaims = z.strictObject({
  /** The workspace the exec runs for. */
  ws: WorkspaceId,
  /** The exec the token was minted for, for logs. */
  exec: z.string().min(1).max(200),
  /** Expiry, epoch seconds. The token is invalid from this second on. */
  exp: z.int().positive(),
});
export type CapabilityClaims = z.infer<typeof CapabilityClaims>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function importKey(key: string): ReturnType<typeof crypto.subtle.importKey> {
  if (key.length < MIN_KEY_LENGTH) {
    return Promise.reject(new RangeError(`a capability key needs at least ${MIN_KEY_LENGTH} characters`));
  }
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Mints a token for `claims`. Throws if the claims or the key are not valid. */
export async function mintCapabilityToken(key: string, claims: CapabilityClaims): Promise<string> {
  const checked = CapabilityClaims.parse(claims);
  const cryptoKey = await importKey(key);
  const payload = toBase64Url(encoder.encode(JSON.stringify(checked)));
  const signed = `${CAPABILITY_TOKEN_PREFIX}.${payload}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signed)));
  return `${signed}.${toBase64Url(mac)}`;
}

/**
 * The claims of a token signed with `key` that has not expired at `nowSeconds`, or `undefined`.
 * Every malformed, forged or expired token gives `undefined`; only a short key throws.
 */
export async function verifyCapabilityToken(
  key: string,
  token: string,
  nowSeconds: number,
): Promise<CapabilityClaims | undefined> {
  const cryptoKey = await importKey(key);
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CAPABILITY_TOKEN_PREFIX) return undefined;
  const [, payload = "", signature = ""] = parts;
  const mac = fromBase64Url(signature);
  if (!mac || !BASE64URL.test(payload)) return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    mac,
    encoder.encode(`${CAPABILITY_TOKEN_PREFIX}.${payload}`),
  );
  if (!valid) return undefined;

  const bytes = fromBase64Url(payload);
  if (!bytes) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
  const claims = CapabilityClaims.safeParse(parsed);
  if (!claims.success || claims.data.exp <= nowSeconds) return undefined;
  return claims.data;
}
