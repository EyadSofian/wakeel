import { createHash } from "node:crypto";

/** ULID's alphabet (Crockford base32, lower case), as ADR-012 ids use it. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * The id of a bot message: `msg_` + a hash of the turn, the step and the message's place in it
 * (architecture §4.4). A step that runs again produces the same ids, so it can never write its
 * output twice: the primary key refuses the second copy.
 */
export function botMessageId(turnId: string, stepSeq: number, index: number): `msg_${string}` {
  const digest = createHash("sha256").update(`${turnId}:${stepSeq}:${index}`).digest();
  let out = "";
  // 26 characters of 5 bits each: 130 bits from the first 17 bytes.
  let bits = 0;
  let value = 0;
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length === 26) break;
  }
  return `msg_${out}`;
}
