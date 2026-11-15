import type { Json } from "@wakeel/contracts";

const REDACTED = "[redacted]";

/** Replaces every occurrence of each secret inside every string of a JSON value. */
function scrub(value: unknown, secrets: readonly string[], patterns: readonly RegExp[], keys: boolean): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
    for (const pattern of patterns) out = out.replace(pattern, REDACTED);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, patterns, keys));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>).map(([k, v]) => [
        keys ? scrub(k, secrets, patterns, false) : k,
        scrub(v, secrets, patterns, keys),
      ]),
    );
  }
  return value;
}

/**
 * The redaction set applied to anything the worker records (task 7.3, ADR-037): every secret config
 * value is replaced by `[redacted]` wherever it appears, whole or inside a longer string. The sandbox
 * already redacts guest logs by key (ADR-023 §6); this also catches a secret that reached a variable,
 * a model prompt or an error message. Secrets shorter than 4 characters are not scrubbed, since they
 * would also match ordinary text.
 */
export function scrubSecrets<T>(
  value: T,
  secrets: readonly string[],
  patterns: readonly RegExp[] = [],
  keys = false,
): T {
  const set = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  return set.length === 0 && patterns.length === 0 ? value : (scrub(value, set, patterns, keys) as T);
}
