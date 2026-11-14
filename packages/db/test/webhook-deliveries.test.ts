import { randomBytes } from "node:crypto";
import { emptyState, newId } from "@wakeel/contracts";
import { getTableColumns } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  appendOutbox,
  claimDelivery,
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  DEAD_EVENTS_TO_DISABLE,
  loadDeliveryStream,
  openSigningSecrets,
  recordAttempt,
  setSigningSecrets,
  sql,
} from "../src/index";
import { webhookDeliveries } from "../src/schema/runtime";

/** Task 5.2 (ADR-028, migration 0009): webhook delivery attempts, created with the outbox, under RLS. */
const urls = inject("db");
let db: Database;
let su: pg.Client;
let rw: pg.Client;

const T0 = new Date("2026-11-14T10:00:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

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

interface Setup {
  webhookUrl?: string | null;
  subscribed?: string[];
  mode?: "live" | "emulator" | "eval";
}

/** A workspace, bot, connection, user and conversation; the conversation's lease is taken (epoch 1). */
async function conversation(setup: Setup = {}) {
  const userId = newId("usr");
  await su.query("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Deliveries",
    slug: `d-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "النور", slug: "noor", createdBy: userId }));
  const ids = { ws, botId: bot.id, conn: newId("conn"), eu: newId("eu"), conv: newId("conv") };
  const url = setup.webhookUrl === undefined ? "https://receiver.example.test/hook" : setup.webhookUrl;
  const subscribed = setup.subscribed ?? ["message.created", "typing", "turn.completed", "conversation.ended"];
  await db.withWorkspace(ws, async (tx) => {
    await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target, webhook_url, subscribed_events)
      values (${ids.conn}, ${ws}, ${ids.botId}, 'Chatwoot', 'production', ${url}, string_to_array(${subscribed.join(",")}, ',')::text[])`);
    await tx.execute(sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id)
      values (${ids.eu}, ${ws}, ${ids.botId}, ${ids.conn}, 'u-1')`);
    await tx.execute(sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes, lease_epoch)
      values (${ids.conv}, ${ws}, ${ids.botId}, ${ids.conn}, ${ids.eu}, 'c-1', ${setup.mode ?? "live"}, 'idle', ${JSON.stringify(emptyState())}::jsonb, 10, 1)`);
  });
  return ids;
}

type Ids = Awaited<ReturnType<typeof conversation>>;

const append = (ids: Ids, events: { type: string; ephemeral?: boolean }[]) =>
  db.withWorkspace(ids.ws, (tx) =>
    appendOutbox(
      tx,
      { conversationId: ids.conv, connectionId: ids.conn, epoch: 1, at: T0 },
      events.map((e) => ({ type: e.type, payload: { data: {} }, ...(e.ephemeral ? { ephemeral: true } : {}) })),
    ),
  );

const deliveries = async (ids: Ids) =>
  (
    await su.query<{ seq: string | null; attempt: number; status: string; ephemeral: boolean; type: string }>(
      `select d.seq, d.attempt, d.status, d.ephemeral, o.type from webhook_deliveries d
         join outbox_events o on o.id = d.outbox_event_id
        where d.conversation_id = $1 order by o.created_at, d.seq nulls first, d.attempt`,
      [ids.conv],
    )
  ).rows;

describe("webhook_deliveries", () => {
  test("the drizzle mirror matches the table", async () => {
    const r = await su.query<{ column_name: string; is_nullable: "YES" | "NO" }>(
      "select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'webhook_deliveries'",
    );
    const inDb = Object.fromEntries(r.rows.map((c) => [c.column_name, c.is_nullable === "NO"]));
    const mirrored = Object.fromEntries(
      Object.values(getTableColumns(webhookDeliveries)).map((c) => [c.name, c.notNull]),
    );
    expect(mirrored).toEqual(inDb);
  });

  test("RLS is enabled and forced", async () => {
    const r = await su.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where relname = 'webhook_deliveries'",
    );
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

describe("appendOutbox creates deliveries (ADR-028 §1)", () => {
  test("one pending first attempt per subscribed event, ephemeral ones included", async () => {
    const ids = await conversation({ subscribed: ["message.created", "typing"] });
    const created = await append(ids, [
      { type: "typing", ephemeral: true },
      { type: "message.created" },
      { type: "turn.completed" },
      { type: "message.created" },
    ]);
    expect(created).toBe(3);
    expect(await deliveries(ids)).toEqual([
      { seq: null, attempt: 1, status: "pending", ephemeral: true, type: "typing" },
      { seq: "1", attempt: 1, status: "pending", ephemeral: false, type: "message.created" },
      { seq: "3", attempt: 1, status: "pending", ephemeral: false, type: "message.created" },
    ]);
  });

  test.each([
    ["no webhook URL", { webhookUrl: null }],
    ["no subscribed events", { subscribed: [] }],
    ["an eval conversation", { mode: "eval" as const }],
  ])("none for %s", async (_label, setup) => {
    const ids = await conversation(setup);
    expect(await append(ids, [{ type: "message.created" }, { type: "typing", ephemeral: true }])).toBe(0);
    expect(await deliveries(ids)).toEqual([]);
  });
});

describe("the stream", () => {
  test("the head is the lowest-seq pending ordered delivery; ephemeral ones come separately", async () => {
    const ids = await conversation();
    await append(ids, [{ type: "message.created" }, { type: "typing", ephemeral: true }, { type: "turn.completed" }]);
    const stream = await db.withWorkspace(ids.ws, (tx) => loadDeliveryStream(tx, ids.conv));
    expect(stream?.connection).toMatchObject({
      id: ids.conn,
      status: "active",
      webhookUrl: "https://receiver.example.test/hook",
    });
    expect(stream?.conversation).toEqual({ id: ids.conv, externalId: "c-1" });
    expect(stream?.user).toEqual({ id: ids.eu, externalId: "u-1" });
    expect(stream?.head?.event).toMatchObject({ seq: 1, type: "message.created" });
    expect(stream?.ephemeral.map((d) => d.event.type)).toEqual(["typing"]);
  });

  test("a delivery can be claimed by one sender until its lease runs out", async () => {
    const ids = await conversation();
    await append(ids, [{ type: "message.created" }]);
    const head = (await db.withWorkspace(ids.ws, (tx) => loadDeliveryStream(tx, ids.conv)))?.head;
    const claim = (now: Date) =>
      db.withWorkspace(ids.ws, (tx) => claimDelivery(tx, head?.id as string, now, new Date(now.getTime() + 30_000)));
    expect(await claim(T0)).toBe(true);
    expect(await claim(later(1_000))).toBe(false);
    expect(await claim(later(31_000))).toBe(true);
  });

  test("a failure with schedule left adds the next attempt; the stream's head stays on that event", async () => {
    const ids = await conversation();
    await append(ids, [{ type: "message.created" }, { type: "turn.completed" }]);
    const head = (await db.withWorkspace(ids.ws, (tx) => loadDeliveryStream(tx, ids.conv)))?.head;
    await db.withWorkspace(ids.ws, (tx) =>
      recordAttempt(tx, head?.id as string, {
        status: "failed",
        attemptedAt: T0,
        durationMs: 12,
        responseStatus: 500,
        error: { code: "webhook_rejected" },
        retryAt: later(5_000),
      }),
    );
    const next = (await db.withWorkspace(ids.ws, (tx) => loadDeliveryStream(tx, ids.conv)))?.head;
    expect(next).toMatchObject({ attempt: 2, nextAttemptAt: later(5_000), event: { seq: 1 } });
    expect((await deliveries(ids)).map((d) => [d.seq, d.attempt, d.status])).toEqual([
      ["1", 1, "failed"],
      ["1", 2, "pending"],
      ["2", 1, "pending"],
    ]);
  });

  test("a dead event raises the connection's dead count, a delivery resets it, and the 20th disables it", async () => {
    const ids = await conversation();
    await append(ids, [{ type: "message.created" }, { type: "message.created" }, { type: "message.created" }]);
    const finishHead = async (status: "delivered" | "dead") => {
      const head = (await db.withWorkspace(ids.ws, (tx) => loadDeliveryStream(tx, ids.conv)))?.head;
      return db.withWorkspace(ids.ws, (tx) => recordAttempt(tx, head?.id as string, { status, attemptedAt: T0 }));
    };
    expect(await finishHead("dead")).toEqual({ disabled: false, consecutiveDead: 1 });
    expect(await finishHead("delivered")).toEqual({ disabled: false, consecutiveDead: 0 });

    await su.query("update bridge_connections set consecutive_dead = $2 where id = $1", [
      ids.conn,
      DEAD_EVENTS_TO_DISABLE - 1,
    ]);
    expect(await finishHead("dead")).toEqual({ disabled: true, consecutiveDead: DEAD_EVENTS_TO_DISABLE });
    const status = await su.query("select status from bridge_connections where id = $1", [ids.conn]);
    expect(status.rows[0].status).toBe("disabled");
  });

  test("a recorded attempt cannot be recorded again", async () => {
    const ids = await conversation();
    await append(ids, [{ type: "message.created" }]);
    const head = (await db.withWorkspace(ids.ws, (tx) => loadDeliveryStream(tx, ids.conv)))?.head;
    await db.withWorkspace(ids.ws, (tx) =>
      recordAttempt(tx, head?.id as string, { status: "delivered", attemptedAt: T0 }),
    );
    await expect(
      db.withWorkspace(ids.ws, (tx) => recordAttempt(tx, head?.id as string, { status: "delivered", attemptedAt: T0 })),
    ).rejects.toThrow(/not pending/);
  });
});

describe("signing secrets", () => {
  const keyring = { current: { version: 1, key: new Uint8Array(randomBytes(32)) } };

  test("are stored sealed, newest first, and open only for their own connection", async () => {
    const ids = await conversation();
    const secrets = ["whsec_new_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "whsec_old_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
    await db.withWorkspace(ids.ws, (tx) =>
      setSigningSecrets(tx, keyring, { workspaceId: ids.ws, connectionId: ids.conn, secrets }),
    );
    const raw = await su.query<{ s: string }>(
      "select signing_secrets::text as s from bridge_connections where id = $1",
      [ids.conn],
    );
    for (const secret of secrets) expect(raw.rows[0]?.s).not.toContain(secret);

    const stream = await db.withWorkspace(ids.ws, (tx) => loadDeliveryStream(tx, ids.conv));
    const stored = stream?.connection.signingSecrets ?? [];
    expect(openSigningSecrets(keyring, { workspaceId: ids.ws, connectionId: ids.conn, stored })).toEqual(secrets);
    expect(() => openSigningSecrets(keyring, { workspaceId: ids.ws, connectionId: newId("conn"), stored })).toThrow();
  });
});

describe("lookup.webhook_streams_due (the janitor)", () => {
  test("lists conversations with a due, unleased delivery on an active connection, and nothing else", async () => {
    const due = await conversation();
    await append(due, [{ type: "message.created" }]);
    const notYet = await conversation();
    await append(notYet, [{ type: "message.created" }]);
    await su.query("update webhook_deliveries set next_attempt_at = $2 where conversation_id = $1", [
      notYet.conv,
      later(60_000),
    ]);
    const leased = await conversation();
    await append(leased, [{ type: "message.created" }]);
    await su.query("update webhook_deliveries set lease_until = $2 where conversation_id = $1", [
      leased.conv,
      later(30_000),
    ]);
    const paused = await conversation();
    await append(paused, [{ type: "message.created" }]);
    await su.query("update bridge_connections set status = 'paused' where id = $1", [paused.conn]);

    const rows = await db.lookup.webhookStreamsDue(later(1_000), 10_000);
    const found = new Set(rows.map((r) => r.conversationId));
    expect(found.has(due.conv)).toBe(true);
    expect(rows.find((r) => r.conversationId === due.conv)?.workspaceId).toBe(due.ws);
    for (const other of [notYet, leased, paused]) expect(found.has(other.conv)).toBe(false);
  });
});

describe.each(["A → B", "B → A"])("two tenants, %s", (direction) => {
  let owner: Ids;
  let other: Ids;

  beforeAll(async () => {
    const a = await conversation();
    const b = await conversation();
    [owner, other] = direction === "A → B" ? [a, b] : [b, a];
    await append(owner, [{ type: "message.created" }]);
  });

  test("the owner sees its deliveries; the other tenant and a bare connection see none", async () => {
    const count = (ws: string) =>
      db.withWorkspace(
        ws,
        async (tx) =>
          (
            await tx.execute(
              sql`select count(*)::int as n from webhook_deliveries where conversation_id = ${owner.conv}`,
            )
          ).rows[0]?.["n"],
      );
    expect(await count(owner.ws)).toBe(1);
    expect(await count(other.ws)).toBe(0);
    expect((await rw.query("select count(*)::int as n from webhook_deliveries")).rows[0].n).toBe(0);
    expect(await db.withWorkspace(other.ws, (tx) => loadDeliveryStream(tx, owner.conv))).toBeUndefined();
  });

  test("the other tenant can neither claim, update nor delete the owner's deliveries", async () => {
    const head = (await db.withWorkspace(owner.ws, (tx) => loadDeliveryStream(tx, owner.conv)))?.head;
    expect(await db.withWorkspace(other.ws, (tx) => claimDelivery(tx, head?.id as string, T0, later(30_000)))).toBe(
      false,
    );
    const updated = await db.withWorkspace(other.ws, (tx) =>
      tx.execute(sql`update webhook_deliveries set status = 'dead'`),
    );
    const deleted = await db.withWorkspace(other.ws, (tx) => tx.execute(sql`delete from webhook_deliveries`));
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
  });

  test("a delivery cannot point at another tenant's event, even with its id", async () => {
    const event = await su.query<{ id: string }>("select id from outbox_events where conversation_id = $1 limit 1", [
      owner.conv,
    ]);
    const forged = db.withWorkspace(other.ws, (tx) =>
      tx.execute(sql`insert into webhook_deliveries (id, workspace_id, connection_id, conversation_id, outbox_event_id, seq, ephemeral, attempt, next_attempt_at)
        values (${newId("dlv")}, ${other.ws}, ${other.conn}, ${other.conv}, ${event.rows[0]?.id}, 1, false, 7, now())`),
    );
    const error = await forged.then(
      () => undefined,
      (e: unknown) => e,
    );
    let current: unknown = error;
    while (current instanceof Error && !("code" in current) && current.cause !== undefined) current = current.cause;
    // Foreign key violation: the event belongs to another workspace.
    expect((current as { code?: string }).code).toBe("23503");
  });
});
