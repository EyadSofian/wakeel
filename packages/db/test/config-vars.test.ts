import { randomBytes } from "node:crypto";
import { AppError, newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  DecryptError,
  deleteConfigValue,
  type Keyring,
  listConfigValues,
  loadConfigEnv,
  putConfigValue,
  sql,
} from "../src/index";

/** Task 7.3 (ADR-037): sealed per environment, bound to the row, secrets never listed; two tenants. */
const urls = inject("db");
let db: Database;
let bare: pg.Client;
const ring: Keyring = { current: { version: 1, key: new Uint8Array(randomBytes(32)) } };
const CANARY = "canary-secret-9e1b7d";

const tenant = async () => {
  const userId = newId("usr");
  await bare.query("insert into users (id, email, name) values ($1, $2, 'Config')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Config",
    slug: `cfg-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const bot = await db.withWorkspace(workspace.id, (tx) =>
    createBot(tx, { name: "Shop", slug: "shop", createdBy: userId }),
  );
  return { ws: workspace.id, botId: bot.id, userId };
};

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

describe("config variable values", () => {
  test("draft and production hold different values; a turn's env has both kinds, secrets in the redaction set", async () => {
    const t = await tenant();
    await db.withWorkspace(t.ws, async (tx) => {
      const put = (env: "draft" | "production", key: string, value: string, isSecret: boolean) =>
        putConfigValue(tx, ring, { workspaceId: t.ws, botId: t.botId, env, key, value, isSecret, userId: t.userId });
      await put("draft", "SHOP_URL", "https://staging.shop.example", false);
      await put("production", "SHOP_URL", "https://shop.example", false);
      await put("draft", "SHOP_TOKEN", "draft-token", true);
      await put("production", "SHOP_TOKEN", CANARY, true);
    });
    const draft = await db.withWorkspace(t.ws, (tx) => loadConfigEnv(tx, ring, t.ws, t.botId, "draft"));
    const prod = await db.withWorkspace(t.ws, (tx) => loadConfigEnv(tx, ring, t.ws, t.botId, "production"));
    expect(draft).toEqual({
      values: { SHOP_URL: "https://staging.shop.example", SHOP_TOKEN: "draft-token" },
      secrets: ["draft-token"],
    });
    expect(prod.values).toEqual({ SHOP_URL: "https://shop.example", SHOP_TOKEN: CANARY });
    expect(prod.secrets).toEqual([CANARY]);
  });

  test("the list shows non-secret values and never a secret one", async () => {
    const t = await tenant();
    await db.withWorkspace(t.ws, async (tx) => {
      await putConfigValue(tx, ring, {
        workspaceId: t.ws,
        botId: t.botId,
        env: "production",
        key: "SHOP_TOKEN",
        value: CANARY,
        isSecret: true,
        userId: null,
      });
      await putConfigValue(tx, ring, {
        workspaceId: t.ws,
        botId: t.botId,
        env: "production",
        key: "REGION",
        value: "مصر",
        isSecret: false,
        userId: null,
      });
    });
    const list = await db.withWorkspace(t.ws, (tx) => listConfigValues(tx, ring, t.ws, t.botId));
    expect(list.map((v) => [v.key, v.env, v.isSecret, v.value])).toEqual([
      ["REGION", "production", false, "مصر"],
      ["SHOP_TOKEN", "production", true, null],
    ]);
    expect(JSON.stringify(list)).not.toContain(CANARY);
  });

  test("values are sealed at rest and do not open when copied to another key", async () => {
    const t = await tenant();
    await db.withWorkspace(t.ws, (tx) =>
      putConfigValue(tx, ring, {
        workspaceId: t.ws,
        botId: t.botId,
        env: "production",
        key: "A",
        value: CANARY,
        isSecret: true,
        userId: null,
      }),
    );
    const raw = await db.withWorkspace(t.ws, (tx) =>
      tx.execute(sql`select ciphertext from bot_config_vars where bot_id = ${t.botId}`),
    );
    expect(Buffer.from((raw.rows[0] as { ciphertext: Buffer }).ciphertext).toString("latin1")).not.toContain(CANARY);
    await db.withWorkspace(t.ws, (tx) =>
      tx.execute(sql`insert into bot_config_vars (workspace_id, bot_id, env, key, ciphertext, key_version, is_secret)
        select workspace_id, bot_id, env, 'B', ciphertext, key_version, true from bot_config_vars where bot_id = ${t.botId} and key = 'A'`),
    );
    await expect(db.withWorkspace(t.ws, (tx) => loadConfigEnv(tx, ring, t.ws, t.botId, "production"))).rejects.toThrow(
      DecryptError,
    );
  });

  test("setting again replaces; deleting removes; deleting a missing value is not_found", async () => {
    const t = await tenant();
    await db.withWorkspace(t.ws, async (tx) => {
      for (const value of ["one", "two"])
        await putConfigValue(tx, ring, {
          workspaceId: t.ws,
          botId: t.botId,
          env: "draft",
          key: "K",
          value,
          isSecret: false,
          userId: null,
        });
    });
    expect((await db.withWorkspace(t.ws, (tx) => loadConfigEnv(tx, ring, t.ws, t.botId, "draft"))).values).toEqual({
      K: "two",
    });
    await db.withWorkspace(t.ws, (tx) => deleteConfigValue(tx, t.botId, "draft", "K"));
    expect((await db.withWorkspace(t.ws, (tx) => loadConfigEnv(tx, ring, t.ws, t.botId, "draft"))).values).toEqual({});
    const e = await db
      .withWorkspace(t.ws, (tx) => deleteConfigValue(tx, t.botId, "draft", "K"))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe("not_found");
  });

  test("two tenants: another workspace sees no values and cannot write to the bot", async () => {
    const a = await tenant();
    const b = await tenant();
    await db.withWorkspace(a.ws, (tx) =>
      putConfigValue(tx, ring, {
        workspaceId: a.ws,
        botId: a.botId,
        env: "production",
        key: "K",
        value: CANARY,
        isSecret: true,
        userId: null,
      }),
    );
    expect(await db.withWorkspace(b.ws, (tx) => listConfigValues(tx, ring, b.ws, a.botId))).toEqual([]);
    expect((await db.withWorkspace(b.ws, (tx) => loadConfigEnv(tx, ring, b.ws, a.botId, "production"))).values).toEqual(
      {},
    );
    await expect(
      db.withWorkspace(b.ws, (tx) =>
        putConfigValue(tx, ring, {
          workspaceId: b.ws,
          botId: a.botId,
          env: "draft",
          key: "K",
          value: "x",
          isSecret: false,
          userId: null,
        }),
      ),
    ).rejects.toThrow();
  });
});
