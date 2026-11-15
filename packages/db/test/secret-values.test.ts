import { randomBytes } from "node:crypto";
import { newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  createDatabase,
  createWorkspace,
  type Database,
  DecryptError,
  getSecret,
  type Keyring,
  putSecret,
  readSecretValue,
  rewrapWorkspaceSecrets,
  storeSecretValue,
} from "../src/index";

/** Task 1.5 with workspace_secrets: encrypted at rest, bound to its row, rotation in place. */
const urls = inject("db");
let db: Database;
let bare: pg.Client;
const v1 = { version: 1, key: new Uint8Array(randomBytes(32)) };
const v2 = { version: 2, key: new Uint8Array(randomBytes(32)) };
const ring1: Keyring = { current: v1 };
const ring2: Keyring = { current: v2, previous: [v1] };
const PLAINTEXT = "sk-ant-api03-canary-7f3a9c";

const workspace = async () => {
  const userId = newId("usr");
  await bare.query("insert into users (id, email, name) values ($1, $2, 'Crypto')", [userId, `${userId}@example.test`]);
  const { workspace: w } = await createWorkspace(db, {
    name: "Crypto",
    slug: `c-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  return w.id;
};

beforeAll(async () => {
  db = createDatabase({ url: urls.rw });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

describe("workspace secrets at rest", () => {
  test("store and read round-trip; the value comes back redacted when printed", async () => {
    const ws = await workspace();
    await db.withWorkspace(ws, (tx) =>
      storeSecretValue(tx, ring1, { workspaceId: ws, name: "anthropic.api_key", value: PLAINTEXT }),
    );
    const value = await db.withWorkspace(ws, (tx) => readSecretValue(tx, ring1, ws, "anthropic.api_key"));
    expect(value?.reveal()).toBe(PLAINTEXT);
    expect(String(value)).toBe("[redacted]");
    expect(JSON.stringify({ value })).not.toContain(PLAINTEXT);
  });

  test("the database never holds the plaintext", async () => {
    const ws = await workspace();
    await db.withWorkspace(ws, (tx) =>
      storeSecretValue(tx, ring1, { workspaceId: ws, name: "openai.api_key", value: PLAINTEXT }),
    );
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    try {
      const { rows } = await su.query(
        "select encode(ciphertext, 'escape') as raw, key_version from workspace_secrets where workspace_id = $1",
        [ws],
      );
      expect(rows[0].key_version).toBe(1);
      expect(rows[0].raw).not.toContain("canary");
    } finally {
      await su.end();
    }
  });

  test("a ciphertext copied to another workspace or name does not decrypt", async () => {
    const a = await workspace();
    const b = await workspace();
    await db.withWorkspace(a, (tx) =>
      storeSecretValue(tx, ring1, { workspaceId: a, name: "anthropic.api_key", value: PLAINTEXT }),
    );
    const stolen = await db.withWorkspace(a, (tx) => getSecret(tx, "anthropic.api_key"));
    if (!stolen) throw new Error("not stored");
    await db.withWorkspace(b, (tx) =>
      putSecret(tx, { name: "anthropic.api_key", ciphertext: stolen.ciphertext, keyVersion: 1 }),
    );
    await db.withWorkspace(a, (tx) =>
      putSecret(tx, { name: "openai.api_key", ciphertext: stolen.ciphertext, keyVersion: 1 }),
    );
    await expect(db.withWorkspace(b, (tx) => readSecretValue(tx, ring1, b, "anthropic.api_key"))).rejects.toThrow(
      DecryptError,
    );
    await expect(db.withWorkspace(a, (tx) => readSecretValue(tx, ring1, a, "openai.api_key"))).rejects.toThrow(
      DecryptError,
    );
  });

  test("rotation re-wraps every secret in place and the plaintext is unchanged", async () => {
    const ws = await workspace();
    await db.withWorkspace(ws, async (tx) => {
      await storeSecretValue(tx, ring1, { workspaceId: ws, name: "a.key", value: "first" });
      await storeSecretValue(tx, ring1, { workspaceId: ws, name: "b.key", value: "ثاني" });
    });
    expect(await db.withWorkspace(ws, (tx) => rewrapWorkspaceSecrets(tx, ring2, ws))).toBe(2);
    expect(await db.withWorkspace(ws, (tx) => rewrapWorkspaceSecrets(tx, ring2, ws))).toBe(0);
    const after = await db.withWorkspace(ws, async (tx) => ({
      a: (await readSecretValue(tx, ring2, ws, "a.key"))?.reveal(),
      b: (await readSecretValue(tx, ring2, ws, "b.key"))?.reveal(),
      version: (await getSecret(tx, "a.key"))?.keyVersion,
    }));
    expect(after).toEqual({ a: "first", b: "ثاني", version: 2 });
    // The old key alone can no longer read them.
    await expect(db.withWorkspace(ws, (tx) => readSecretValue(tx, ring1, ws, "a.key"))).rejects.toThrow(/version 2/);
  });
});
