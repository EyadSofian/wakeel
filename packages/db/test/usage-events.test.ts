import { randomBytes } from "node:crypto";
import { emptyState, type Json, newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  ensureConversation,
  insertUsageEvent,
  insertUserMessage,
  readDailyUsage,
  rollupUsageDay,
  sql,
  upsertEndUser,
  usageTotals,
} from "../src/index";

/** Task 6.1 (migration 0011): usage events, partitioned by month, under RLS. */
const urls = inject("db");
let db: Database;
let su: pg.Client;
let rw: pg.Client;

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  su = new pg.Client({ connectionString: urls.superuser });
  rw = new pg.Client({ connectionString: urls.rw });
  await Promise.all([su.connect(), rw.connect()]);
});

afterAll(async () => {
  await Promise.allSettled([su?.end(), rw?.end()]);
  await db?.close();
});

async function workspace() {
  const userId = newId("usr");
  await su.query("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Usage",
    slug: `u-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  return workspace.id;
}

const event = {
  kind: "llm_tokens" as const,
  quantity: 1200,
  unit: "tokens" as const,
  model: "claude-sonnet-5-5",
  costMicroUsd: 4200,
  mode: "live" as const,
  detail: { inputTokens: 1000, outputTokens: 200 },
};

describe.each(["A → B", "B → A"])("two tenants, %s", (direction) => {
  test("the owner sees its events; the other tenant and a bare connection see none", async () => {
    const [a, b] = [await workspace(), await workspace()];
    const [owner, other] = direction === "A → B" ? [a, b] : [b, a];
    await db.withWorkspace(owner, (tx) => insertUsageEvent(tx, event));
    const count = (ws: string) =>
      db.withWorkspace(
        ws,
        async (tx) => (await tx.execute(sql`select count(*)::int as n from usage_events`)).rows[0]?.["n"],
      );
    expect(await count(owner)).toBe(1);
    expect(await count(other)).toBe(0);
    expect((await rw.query("select count(*)::int as n from usage_events")).rows[0].n).toBe(0);
    const deleted = await db.withWorkspace(other, (tx) => tx.execute(sql`delete from usage_events`));
    expect(deleted.rowCount).toBe(0);
  });
});

describe("usage_events", () => {
  test("daily roll-ups match event sums by mode, are repeatable, and remain tenant-scoped", async () => {
    const [owner, other] = [await workspace(), await workspace()];
    await db.withWorkspace(owner, async (tx) => {
      for (const [mode, quantity, cost] of [
        ["live", 2, 7],
        ["live", 3, 11],
        ["emulator", 9, 31],
        ["eval", 4, 17],
      ] as const) {
        const id = await insertUsageEvent(tx, { ...event, mode, quantity, costMicroUsd: cost });
        await tx.execute(sql`update usage_events set at='2026-11-14T12:00:00Z' where id=${id}`);
      }
      const result = await rollupUsageDay(tx, "2026-11-14");
      expect(result.map(({ mode, quantity, costMicroUsd }) => ({ mode, quantity, costMicroUsd }))).toEqual([
        { mode: "emulator", quantity: 9, costMicroUsd: 31 },
        { mode: "eval", quantity: 4, costMicroUsd: 17 },
        { mode: "live", quantity: 5, costMicroUsd: 18 },
      ]);
      expect(await rollupUsageDay(tx, "2026-11-14")).toEqual(result);
      expect(await readDailyUsage(tx, "2026-11-15")).toEqual([]);
    });
    expect(await db.withWorkspace(other, (tx) => readDailyUsage(tx, "2026-11-14"))).toEqual([]);
    expect((await rw.query("select * from usage_daily")).rows).toEqual([]);
    await expect(
      db.withWorkspace(other, (tx) =>
        tx.execute(sql`insert into usage_daily
      (workspace_id, day, kind, mode, quantity, cost_micro_usd) values
      (${owner}, '2026-11-14', 'llm_tokens', 'live', 1, 0)`),
      ),
    ).rejects.toThrow();
  });

  test("occupancy uses the last sample per bot, excluding archived bots and non-live modes", async () => {
    const ws = await workspace();
    const userId = (await su.query("select user_id from memberships where workspace_id=$1", [ws])).rows[0]
      .user_id as string;
    await db.withWorkspace(ws, async (tx) => {
      const bot = await createBot(tx, { name: "مخزون ORD-12", slug: "storage", createdBy: userId });
      const archived = await createBot(tx, { name: "أرشيف", slug: "archive", createdBy: userId });
      await tx.execute(sql`update bots set archived_at=now() where id=${archived.id}`);
      const sample = async (botId: string, quantity: number, time: string) => {
        const id = await insertUsageEvent(tx, {
          kind: "table_rows",
          quantity,
          unit: "rows",
          mode: "live",
          botId,
          detail: { measurement: "snapshot" },
        });
        await tx.execute(sql`update usage_events set at=${time}::timestamptz where id=${id}`);
      };
      await sample(bot.id, 10, "2026-11-10T10:00:00Z");
      await sample(bot.id, 4, "2026-11-10T11:00:00Z");
      await sample(archived.id, 100, "2026-11-10T11:00:00Z");
      await insertUsageEvent(tx, { ...event, quantity: 50, mode: "emulator" });
      await insertUsageEvent(tx, { ...event, quantity: 20, mode: "eval" });
      expect(await usageTotals(tx, new Date("2026-11-01"), new Date("2026-12-01"))).toEqual([
        { kind: "table_rows", quantity: 4, costMicroUsd: 0 },
      ]);
    });
  });

  test("accounting identities deduplicate retries and stay isolated by workspace", async () => {
    const [a, b] = [await workspace(), await workspace()];
    const input = { ...event, sourceKey: "delivery:one:1" };
    const first = await db.withWorkspace(a, (tx) => insertUsageEvent(tx, input));
    expect(await db.withWorkspace(a, (tx) => insertUsageEvent(tx, input))).toBe(first);
    expect(await db.withWorkspace(b, (tx) => insertUsageEvent(tx, input))).not.toBe(first);
    for (const ws of [a, b]) {
      const rows = await db.withWorkspace(ws, (tx) => tx.execute(sql`select usage_id from usage_sources`));
      expect(rows.rows).toHaveLength(1);
      expect(
        await db.withWorkspace(ws, (tx) => usageTotals(tx, new Date("2000-01-01"), new Date("2100-01-01"))),
      ).toEqual([{ kind: "llm_tokens", quantity: 1200, costMicroUsd: 4200 }]);
    }
    expect((await rw.query("select * from usage_sources")).rows).toEqual([]);
    await expect(
      db.withWorkspace(a, (tx) =>
        tx.execute(sql`insert into usage_sources
      (workspace_id, source_key, usage_id) values (${b}, 'forged', ${newId("usg")})`),
      ),
    ).rejects.toThrow();
  });

  test("a row cannot name another workspace", async () => {
    const [a, b] = [await workspace(), await workspace()];
    await expect(
      db.withWorkspace(a, (tx) =>
        tx.execute(sql`insert into usage_events (id, workspace_id, kind, quantity, unit, mode)
          values (${newId("usg")}, ${b}, 'llm_tokens', 1, 'tokens', 'live')`),
      ),
    ).rejects.toThrow();
  });

  test("partitions cannot be read directly, and each has RLS enabled and forced", async () => {
    await expect(rw.query("select count(*) from usage_events_2026_11")).rejects.toThrow(/permission denied/);
    await expect(rw.query("select count(*) from usage_events_default")).rejects.toThrow(/permission denied/);
    const { rows } = await su.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'usage_events'::regclass`);
    expect(rows.length).toBe(9);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });
});

test("conversation usage is counted once at the second user message, with its traffic mode", async () => {
  for (const mode of ["live", "emulator", "eval"] as const) {
    const ws = await workspace();
    const userId = (await su.query("select user_id from memberships where workspace_id=$1", [ws])).rows[0]
      .user_id as string;
    const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "المتجر", slug: "shop", createdBy: userId }));
    const connectionId = newId("conn");
    await db.withWorkspace(ws, async (tx) => {
      await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
        values (${connectionId}, ${ws}, ${bot.id}, 'Meter', 'draft')`);
      const user = await upsertEndUser(tx, { botId: bot.id, connectionId, externalId: "a", patch: {} });
      const conversation = await ensureConversation(tx, {
        botId: bot.id,
        connectionId,
        endUserId: user.id,
        externalId: "chat",
        mode,
        state: emptyState() as unknown as Record<string, Json>,
        stateBytes: 10,
      });
      const message = () =>
        insertUserMessage(tx, {
          conversationId: conversation.id,
          type: "text",
          payload: { type: "text", text: "فاتورة ORD-12" },
        });
      await message();
      expect(
        (await tx.execute(sql`select count(*)::int as n from usage_events where kind='conversation'`)).rows[0]?.["n"],
      ).toBe(0);
      await message();
      await message();
      const events = await tx.execute(
        sql`select mode, quantity::int as quantity from usage_events where kind='conversation'`,
      );
      expect(events.rows).toEqual([{ mode, quantity: 1 }]);
      expect(await usageTotals(tx, new Date("2000-01-01"), new Date("2100-01-01"))).toEqual(
        mode === "live" ? [{ kind: "conversation", quantity: 1, costMicroUsd: 0 }] : [],
      );
    });
  }
});
