import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, SIGNATURE_TOLERANCE_SECONDS, signaturePayload } from "@wakeel/contracts";

/**
 * Webhook signing and verification (task 5.1, architecture §9.2, ADR-005, threat T6).
 *
 * Header: `X-Wakeel-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]`, where each hex value is
 * `HMAC-SHA256(secret, t + "." + rawBody)` over the exact bytes sent, one per active secret.
 *
 * Secrets are plaintext strings here. Storage (`bridge_connections.signing_secrets`, newest first)
 * holds them sealed with the master keyring; sealing is the repository's job, not this module's.
 * Nothing in this module logs a secret, puts one in an error, or returns one except
 * `generateSigningSecret` and the rotation helpers, whose callers must show it once and seal it.
 */

export const SIGNING_SECRET_PREFIX = "whsec_";
/** Two secrets are active while one is being rotated (§9.2). */
export const MAX_ACTIVE_SIGNING_SECRETS = 2;

const SECRET_BYTES = 32;
const SIGNATURE_SCHEME = "v1";
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{1,15}$/u;
/** A real header is under 200 characters; anything far longer is not worth parsing. */
const MAX_HEADER_LENGTH = 4_096;

/** The raw request body: the string that was sent, or the bytes that were received. */
export type RawBody = string | Uint8Array;

function invariant(condition: boolean, detail: string): asserts condition {
  // Programmer errors only; the detail never carries a secret or a body.
  if (!condition) throw new AppError("internal_error", {}, { detail });
}

function assertTimestamp(timestamp: number): void {
  invariant(Number.isSafeInteger(timestamp) && timestamp >= 0, "Signature timestamp must be whole unix seconds");
}

function assertSecret(secret: string): void {
  invariant(typeof secret === "string" && secret.length > 0, "Signing secret must be a non-empty string");
}

/**
 * Creates a new signing secret: `whsec_` followed by 32 random bytes in base64url. Show it once and
 * store it sealed; never log it.
 */
export function generateSigningSecret(): string {
  return `${SIGNING_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

function hmac(secret: string, timestamp: number, rawBody: RawBody): Buffer {
  assertSecret(secret);
  assertTimestamp(timestamp);
  const mac = createHmac("sha256", secret);
  if (typeof rawBody === "string") {
    mac.update(signaturePayload(timestamp, rawBody), "utf8");
  } else {
    // Same bytes as `signaturePayload`, without decoding the body: it is signed exactly as received.
    mac.update(`${timestamp}.`, "utf8");
    mac.update(rawBody);
  }
  return mac.digest();
}

/** Returns the lowercase hex `v1` value for one secret. The secret is used as UTF-8 bytes. */
export function computeSignature(secret: string, timestamp: number, rawBody: RawBody): string {
  return hmac(secret, timestamp, rawBody).toString("hex");
}

/**
 * Builds the `X-Wakeel-Signature` value with one `v1` per active secret, newest first. Takes one
 * secret normally and two during a rotation.
 */
export function signatureHeader(secrets: readonly string[], timestamp: number, rawBody: RawBody): string {
  invariant(
    secrets.length >= 1 && secrets.length <= MAX_ACTIVE_SIGNING_SECRETS,
    `A connection signs with 1 to ${MAX_ACTIVE_SIGNING_SECRETS} secrets, got ${secrets.length}`,
  );
  assertTimestamp(timestamp);
  const values = secrets.map((secret) => `${SIGNATURE_SCHEME}=${computeSignature(secret, timestamp, rawBody)}`);
  return [`t=${timestamp}`, ...values].join(",");
}

export interface ParsedSignatureHeader {
  timestamp: number;
  /** Every `v1` value, in header order, unchecked. */
  signatures: string[];
}

/**
 * Parses a signature header. Returns `undefined` unless it has exactly one numeric `t` and at least
 * one `v1`. Items with other schemes are ignored so a later scheme can be added alongside `v1`.
 */
export function parseSignatureHeader(value: string): ParsedSignatureHeader | undefined {
  if (value.length === 0 || value.length > MAX_HEADER_LENGTH) return undefined;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const raw of value.split(",")) {
    const item = raw.trim();
    const eq = item.indexOf("=");
    if (eq <= 0 || eq === item.length - 1) return undefined;
    const key = item.slice(0, eq);
    const val = item.slice(eq + 1);
    if (key === "t") {
      if (timestamp !== undefined || !TIMESTAMP_PATTERN.test(val)) return undefined;
      timestamp = Number(val);
    } else if (key === SIGNATURE_SCHEME) {
      signatures.push(val);
    }
  }
  if (timestamp === undefined || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

export type VerifyFailureReason = "malformed_header" | "timestamp_out_of_tolerance" | "signature_mismatch";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailureReason };

export interface VerifyInput {
  /** The `X-Wakeel-Signature` value as received. */
  header: string;
  /** The body exactly as received, before any JSON parsing. */
  rawBody: RawBody;
  /** The secrets the receiver holds; any one matching any `v1` is enough. */
  secrets: readonly string[];
  /** The receiver's clock in unix seconds. */
  nowSeconds: number;
  /** Defaults to `SIGNATURE_TOLERANCE_SECONDS` (300). */
  toleranceSeconds?: number;
}

/**
 * Verifies a delivery the way a receiver must (OpenAPI "Verifying a webhook"): the timestamp is
 * within the tolerance of `nowSeconds` in either direction, and some secret's HMAC equals some `v1`
 * value. Every secret is compared with every well-formed `v1` in constant time, without stopping
 * early, so the time taken does not reveal which pair matched or how close a guess was.
 */
export function verifySignature(input: VerifyInput): VerifyResult {
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  invariant(Number.isFinite(input.nowSeconds), "nowSeconds must be a finite number");
  invariant(Number.isFinite(tolerance) && tolerance >= 0, "toleranceSeconds must be a non-negative number");

  const parsed = parseSignatureHeader(input.header);
  if (!parsed) return { ok: false, reason: "malformed_header" };
  if (Math.abs(input.nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const candidates = parsed.signatures.filter((s) => SIGNATURE_PATTERN.test(s)).map((s) => Buffer.from(s, "hex"));
  let matched = false;
  for (const secret of input.secrets) {
    const expected = hmac(secret, parsed.timestamp, input.rawBody);
    for (const candidate of candidates) {
      // Both are 32 bytes: the pattern above fixes the candidate's length.
      if (timingSafeEqual(expected, candidate)) matched = true;
    }
  }
  return matched ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

export interface Rotation {
  /** The secrets to store, newest first. */
  secrets: string[];
  /** The new secret: show it once, then it lives only sealed in storage. */
  created: string;
}

/**
 * Starts a rotation: a new secret goes first and the current newest stays, so receivers keep
 * verifying with either while they switch. Rotating again before the rotation is ended drops the
 * oldest, keeping at most two. A connection with no secret gets its first one.
 */
export function rotateSigningSecrets(current: readonly string[]): Rotation {
  invariant(
    current.length <= MAX_ACTIVE_SIGNING_SECRETS,
    `A connection holds at most ${MAX_ACTIVE_SIGNING_SECRETS} signing secrets, got ${current.length}`,
  );
  const created = generateSigningSecret();
  return { secrets: [created, ...current].slice(0, MAX_ACTIVE_SIGNING_SECRETS), created };
}

/** Ends a rotation: only the newest secret stays active. A no-op when only one is active. */
export function endRotation(current: readonly string[]): string[] {
  const [newest] = current;
  invariant(newest !== undefined, "There is no signing secret to keep");
  return [newest];
}
