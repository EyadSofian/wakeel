import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { PERMISSION_NAMES, type Permission } from "./rbac";

/**
 * API keys (task 1.4, ADR-012, threat T7). A key reads `wk_live_<prefix>_<secret>` (workspace) or
 * `wk_bridge_<prefix>_<secret>` (one connection, Phase 4). The 8-character prefix locates the row;
 * only the SHA-256 of the secret is stored. The full key is shown once, when it is created.
 */

export type KeyKind = "workspace" | "bridge";

const MARKER: Record<KeyKind, string> = { workspace: "wk_live_", bridge: "wk_bridge_" };
const PREFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const PREFIX_LENGTH = 8;
const SECRET_BYTES = 32;
const KEY_PATTERN = /^wk_(live|bridge)_([0-9a-z]{8})_([A-Za-z0-9_-]{43})$/;

export interface NewKey {
  /** Shown to the user once; never stored or logged. */
  key: string;
  prefix: string;
  /** SHA-256 hex of the secret part; the only thing stored. */
  secretHash: string;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateKey(kind: KeyKind): NewKey {
  let prefix = "";
  for (let i = 0; i < PREFIX_LENGTH; i++) prefix += PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)];
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { key: `${MARKER[kind]}${prefix}_${secret}`, prefix, secretHash: hashSecret(secret) };
}

export interface ParsedKey {
  kind: KeyKind;
  prefix: string;
  secret: string;
}

/** Splits a presented key, or returns `undefined` when it is not in our format. */
export function parseKey(value: string): ParsedKey | undefined {
  const m = KEY_PATTERN.exec(value);
  if (!m) return undefined;
  const [, marker, prefix, secret] = m;
  if (prefix === undefined || secret === undefined) return undefined;
  return { kind: marker === "live" ? "workspace" : "bridge", prefix, secret };
}

/** Compares a presented secret with the stored hash in constant time. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Permissions a workspace key may carry. Keys are for automation (CI, scripts, n8n): they may build,
 * publish and read, but never manage people, other keys or secrets, or delete the workspace, so a
 * leaked key cannot lock its owners out or mint more keys.
 */
const NOT_FOR_KEYS: ReadonlySet<Permission> = new Set<Permission>([
  "workspace.update",
  "workspace.delete",
  "member.invite",
  "member.update_role",
  "member.remove",
  "api_key.read",
  "api_key.create",
  "api_key.revoke",
  "secret.read",
  "secret.write",
]);

export const KEY_SCOPES: readonly Permission[] = PERMISSION_NAMES.filter((p) => !NOT_FOR_KEYS.has(p));
