import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for secrets at rest (task 1.5, architecture §17, threat T5).
 *
 * Each value gets its own random 256-bit data key. The value is encrypted with the data key
 * (AES-256-GCM); the data key is encrypted ("wrapped") with the master key of the current version.
 * The row stores both, plus `key_version`. Rotating the master key re-wraps the data key only: the
 * encrypted value, and so the plaintext, does not change.
 *
 * Every value is bound to where it lives through additional authenticated data (AAD), for example
 * `workspace_secrets:<workspaceId>:<name>`. Moving a ciphertext to another row or tenant makes
 * decryption fail instead of returning someone else's secret.
 *
 * Layout (all one `bytea`):
 *   [0]        format version (1)
 *   [1..12]    nonce for the wrapped data key
 *   [13..44]   wrapped data key (32 bytes)
 *   [45..60]   tag for the wrapped data key
 *   [61..72]   nonce for the value
 *   [73..88]   tag for the value
 *   [89..]     encrypted value
 */

const FORMAT = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;
const HEADER_BYTES = 1 + WRAPPED_BYTES + NONCE_BYTES + TAG_BYTES;

export interface MasterKey {
  version: number;
  /** 32 bytes. */
  key: Uint8Array;
}

/** The current master key plus older ones still needed to read rows not yet re-wrapped. */
export interface Keyring {
  current: MasterKey;
  previous?: readonly MasterKey[];
}

export interface Sealed {
  ciphertext: Buffer;
  keyVersion: number;
}

/** Decryption failed: wrong or missing master key, tampered bytes, or a value moved to another row. */
export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}

/** Checks a keyring at boot so a bad MASTER_KEY stops the service instead of failing on first use. */
export function validateKeyring(keyring: Keyring): void {
  const all = [keyring.current, ...(keyring.previous ?? [])];
  const versions = new Set<number>();
  for (const k of all) {
    if (!Number.isInteger(k.version) || k.version < 1) throw new Error(`Master key version ${k.version} is not valid`);
    if (k.key.length !== KEY_BYTES) throw new Error(`Master key version ${k.version} is not ${KEY_BYTES} bytes`);
    if (versions.has(k.version)) throw new Error(`Master key version ${k.version} appears twice`);
    versions.add(k.version);
  }
}

const masterFor = (keyring: Keyring, version: number): MasterKey => {
  const found = [keyring.current, ...(keyring.previous ?? [])].find((k) => k.version === version);
  if (!found) throw new DecryptError(`No master key with version ${version} is configured`);
  return found;
};

const wrapAad = (aad: string, version: number) => Buffer.from(`wakeel:dek:v${FORMAT}:k${version}:${aad}`, "utf8");
const valueAad = (aad: string) => Buffer.from(`wakeel:value:v${FORMAT}:${aad}`, "utf8");

function gcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad: Buffer) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, body, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Uint8Array, nonce: Buffer, body: Buffer, tag: Buffer, aad: Buffer, what: string): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // The underlying message ("Unsupported state or unable to authenticate data") says nothing useful.
    throw new DecryptError(`Could not decrypt the ${what}`);
  }
}

const wrap = (master: MasterKey, dataKey: Buffer, aad: string): Buffer => {
  const { nonce, body, tag } = gcmEncrypt(master.key, dataKey, wrapAad(aad, master.version));
  return Buffer.concat([nonce, body, tag]);
};

const unwrap = (master: MasterKey, wrapped: Buffer, aad: string): Buffer =>
  gcmDecrypt(
    master.key,
    wrapped.subarray(0, NONCE_BYTES),
    wrapped.subarray(NONCE_BYTES, NONCE_BYTES + KEY_BYTES),
    wrapped.subarray(NONCE_BYTES + KEY_BYTES),
    wrapAad(aad, master.version),
    "data key",
  );

function split(ciphertext: Buffer) {
  if (ciphertext.length < HEADER_BYTES || ciphertext[0] !== FORMAT) {
    throw new DecryptError("The stored value is not in a known format");
  }
  const wrapped = ciphertext.subarray(1, 1 + WRAPPED_BYTES);
  const rest = ciphertext.subarray(1 + WRAPPED_BYTES);
  return {
    wrapped,
    valueNonce: rest.subarray(0, NONCE_BYTES),
    valueTag: rest.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES),
    valueBody: rest.subarray(NONCE_BYTES + TAG_BYTES),
  };
}

/** Encrypts `plaintext` for the row described by `aad`, with a fresh data key. */
export function seal(keyring: Keyring, plaintext: string | Uint8Array, aad: string): Sealed {
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const value = gcmEncrypt(dataKey, bytes, valueAad(aad));
    const ciphertext = Buffer.concat([
      Buffer.from([FORMAT]),
      wrap(keyring.current, dataKey, aad),
      value.nonce,
      value.tag,
      value.body,
    ]);
    return { ciphertext, keyVersion: keyring.current.version };
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypts a sealed value. Throws `DecryptError` on any mismatch; never returns partial data. */
export function open(keyring: Keyring, sealed: Sealed, aad: string): Buffer {
  const parts = split(sealed.ciphertext);
  const dataKey = unwrap(masterFor(keyring, sealed.keyVersion), parts.wrapped, aad);
  try {
    return gcmDecrypt(dataKey, parts.valueNonce, parts.valueBody, parts.valueTag, valueAad(aad), "value");
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Re-wraps the data key under the current master key. The encrypted value is copied byte for
 * byte, so the plaintext cannot change. A value already on the current version is returned as is.
 */
export function rewrap(keyring: Keyring, sealed: Sealed, aad: string): Sealed {
  if (sealed.keyVersion === keyring.current.version) return sealed;
  const parts = split(sealed.ciphertext);
  const dataKey = unwrap(masterFor(keyring, sealed.keyVersion), parts.wrapped, aad);
  try {
    const ciphertext = Buffer.concat([
      Buffer.from([FORMAT]),
      wrap(keyring.current, dataKey, aad),
      sealed.ciphertext.subarray(1 + WRAPPED_BYTES),
    ]);
    return { ciphertext, keyVersion: keyring.current.version };
  } finally {
    dataKey.fill(0);
  }
}
