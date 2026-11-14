import { randomBytes } from "node:crypto";
import { newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { createDatabase, createWorkspace, type Database, insertUsageEvent, sql } from "../src/index";

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
