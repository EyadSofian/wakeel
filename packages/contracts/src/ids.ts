/**
 * The only place ids are created (CLAUDE.md, ADR-012). Formats match the regexes in `common.ts`:
 *
 * - Stored entities: `<prefix>_<ULID>` in lower-case Crockford base32 (26 chars). The first 10 chars
 *   encode the creation time in milliseconds, so ids sort roughly by creation.
 * - Definition elements: `<prefix>_<10-char nanoid>` over `[0-9A-Za-z]`. They only need to be unique
 *   within one bot, and short ids keep definitions readable.
 *
 * Randomness comes from `crypto.getRandomValues`, available in Node 22, browsers and web workers.
 */

/** Prefixes of stored entities. Keep in sync with the `entityId(...)` calls in `common.ts` (a test checks). */
export const ENTITY_PREFIXES = [
  "ws",
  "bot",
  "ver",
  "conn",
  "eu",
  "conv",
  "msg",
  "evt",
  "turn",
  "span",
  "kb",
  "doc",
  "chk",
  "tbl",
  "row",
] as const;
export type EntityPrefix = (typeof ENTITY_PREFIXES)[number];

/** Prefixes of definition elements. Keep in sync with the `elementId(...)` calls in `common.ts` (a test checks). */
export const ELEMENT_PREFIXES = ["wf", "node", "card", "edge", "var", "tool", "exit", "br", "col"] as const;
export type ElementPrefix = (typeof ELEMENT_PREFIXES)[number];

/** Crockford base32 without i, l, o, u; lower-case as stored. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const NANO_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const ULID_TIME_CHARS = 10;
const ULID_RANDOM_CHARS = 16;
const ELEMENT_ID_CHARS = 10;
/** 2^48 - 1: the largest time a ULID can encode (year 10889). */
const ULID_MAX_TIME = 281_474_976_710_655;

export interface NewIdOptions {
  /** Milliseconds since the epoch to encode. Defaults to `Date.now()`; tests pass a fake clock value. */
  now?: number;
}

/** Creates a stored-entity id such as `conv_01jcqz5p6q7r8s9t0v1w2x3y4z`. */
export function newId<P extends EntityPrefix>(prefix: P, options: NewIdOptions = {}): `${P}_${string}` {
  return `${prefix}_${ulid(options.now ?? Date.now())}`;
}

/** Request ids (ADR-012 problem documents, logs, `X-Request-Id`): `req_<ULID>`. Not stored entities. */
export const REQUEST_ID_PATTERN = /^req_[0-9a-hjkmnp-tv-z]{26}$/;

export function newRequestId(options: NewIdOptions = {}): `req_${string}` {
  return `req_${ulid(options.now ?? Date.now())}`;
}

/** Creates a definition-element id such as `card_V1StGXR8Z5`. */
export function newElementId<P extends ElementPrefix>(prefix: P): `${P}_${string}` {
  return `${prefix}_${nanoid(ELEMENT_ID_CHARS)}`;
}

function ulid(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > ULID_MAX_TIME) {
    throw new RangeError(`ULID time must be an integer between 0 and ${ULID_MAX_TIME}; got ${now}`);
  }
  let time = "";
  let rest = now;
  for (let i = 0; i < ULID_TIME_CHARS; i++) {
    // 2^48 exceeds 32 bits, so use arithmetic rather than bit operators.
    time = CROCKFORD.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }

  // 80 random bits = 10 bytes, read 5 bits at a time.
  const bytes = randomBytes(10);
  let random = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += CROCKFORD.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  if (random.length !== ULID_RANDOM_CHARS) throw new Error("ULID random part has the wrong length");
  return time + random;
}

function nanoid(size: number): string {
  // Rejection sampling over 6-bit values keeps every character equally likely (62 of 64 values accepted).
  let id = "";
  while (id.length < size) {
    for (const byte of randomBytes(size * 2)) {
      const index = byte & 63;
      if (index < NANO_ALPHABET.length) id += NANO_ALPHABET.charAt(index);
      if (id.length === size) break;
    }
  }
  return id;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
