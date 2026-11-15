import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * CSRF tokens for cookie-authenticated mutations (ADR-012, threat T7). The token is an HMAC of the
 * session token under the auth secret: the Studio reads it from the session response and sends it
 * as `X-CSRF-Token`. Another site can make the browser send the cookie but cannot read the token.
 * Signing out or rotating the session changes it.
 */
export const CSRF_HEADER = "x-csrf-token";

export function csrfTokenFor(secret: string, sessionToken: string): string {
  return createHmac("sha256", secret).update(`csrf:v1:${sessionToken}`).digest("base64url");
}

export function verifyCsrfToken(secret: string, sessionToken: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const expected = Buffer.from(csrfTokenFor(secret, sessionToken));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
