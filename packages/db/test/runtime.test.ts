import { randomBytes } from "node:crypto";
import { newId } from "@wakeel/contracts";
import { getTableColumns, getTableName } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { createBot, createDatabase, createWorkspace, type Database, deleteBot, runtimeTables, sql } from "../src/index";
import { findRlsProblems } from "../src/rls";

/**
 * Task 4.1: the runtime tables (architecture §2.3 "Runtime", §4.2–4.4). Two tenants per table,
 * the unique constraints on external ids and idempotency keys, and the composite foreign keys that
 * keep one tenant's rows from pointing at another's.
 */
const urls = inject("db");
let db: Database;
let bare: pg.Client;

const RUNTIME_TABLES = [
  "bridge_connections",
  "end_users",
  "conversations",
  "inbound_events",
  "turns",
  "messages",
  "outbox_events",
] as const;

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

/** The Postgres error under drizzle's wrapper. */
async function pgError(promise: Promise<unknown>): Promise<{ code: string; constraint?: string; message: string }> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  let current: unknown = error;
  while (current instanceof Error && !("code" in current) && current.cause !== undefined) current = current.cause;
  expect(current, "expected the statement to fail").toBeInstanceOf(Error);
  return current as { code: string; constraint?: string; message: string };
}

const UNIQUE = "23505";
const FOREIGN_KEY = "23503";
const CHECK = "23514";
const RLS = "42501";

async function tenant() {
  const userId = newId("usr");
  await bare.query("insert into users (id, email, name) values ($1, $2, 'Builder')", [
    userId,
    `${userId}@example.test`,
  ]);
  const { workspace } = await createWorkspace(db, {
    name: "Runtime",
    slug: `r-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const bot = await db.withWorkspace(workspace.id, (tx) =>
    createBot(tx, { name: "النور", slug: "noor", createdBy: userId }),
  );
  return { ws: workspace.id, botId: bot.id, userId };
}

type Tenant = Awaited<ReturnType<typeof tenant>>;

interface Chain {
  connectionId: string;
  endUserId: string;
  conversationId: string;
  eventId: string;
  turnId: string;
  messageId: string;
  outboxId: string;
}

/** One row in every runtime table, linked the way the inbound path and the worker link them. */
async function chain(t: Tenant, externalId = `ext-${randomBytes(4).toString("hex")}`): Promise<Chain> {
  const c: Chain = {
    connectionId: newId("conn"),
    endUserId: newId("eu"),
    conversationId: newId("conv"),
    eventId: newId("evt"),
    turnId: newId("turn"),
    messageId: newId("msg"),
    outboxId: newId("out"),
  };
  await db.withWorkspace(t.ws, async (tx) => {
    await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
      values (${c.connectionId}, ${t.ws}, ${t.botId}, 'Website', 'production')`);
    await tx.execute(sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id, attributes)
      values (${c.endUserId}, ${t.ws}, ${t.botId}, ${c.connectionId}, ${externalId}, ${JSON.stringify({ name: "منى" })}::jsonb)`);
    await tx.execute(sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes)
      values (${c.conversationId}, ${t.ws}, ${t.botId}, ${c.connectionId}, ${c.endUserId}, ${externalId}, 'live', 'idle', '{}'::jsonb, 2)`);
    await tx.execute(sql`insert into inbound_events (id, workspace_id, connection_id, conversation_id, seq, kind, payload, idempotency_key)
      values (${c.eventId}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 1, 'message', ${JSON.stringify({ text: "مرحبا" })}::jsonb, ${`idem-${externalId}`})`);
    await tx.execute(sql`insert into turns (id, workspace_id, conversation_id, bot_id, trigger_event_id, status)
      values (${c.turnId}, ${t.ws}, ${c.conversationId}, ${t.botId}, ${c.eventId}, 'running')`);
    await tx.execute(
      sql`update inbound_events set turn_id = ${c.turnId}, processed_at = now() where id = ${c.eventId}`,
    );
    await tx.execute(sql`insert into messages (id, workspace_id, conversation_id, seq, direction, type, payload, turn_id)
      values (${c.messageId}, ${t.ws}, ${c.conversationId}, 1, 'out', 'text', ${JSON.stringify({ type: "text", text: "أهلاً" })}::jsonb, ${c.turnId})`);
    await tx.execute(sql`insert into outbox_events (id, workspace_id, connection_id, conversation_id, seq, type, payload, ephemeral)
      values (${c.outboxId}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 1, 'message.created', '{}'::jsonb, false)`);
  });
  return c;
}

const count = async (ws: string, table: string) =>
  db.withWorkspace(ws, async (tx) => {
    const r = await tx.execute(sql.raw(`select count(*)::int as n from ${table}`));
    return (r.rows[0] as { n: number }).n;
  });

describe("the runtime tables", () => {
  test("exist, each with workspace_id and forced RLS with the standard policy", async () => {
    const su = new pg.Client({ connectionString: urls.superuser });
    await su.connect();
    try {
      const found = await su.query<{ relname: string; forced: boolean }>(
        `select c.relname, c.relforcerowsecurity as forced from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and not a.attisdropped
         where c.relnamespace = 'public'::regnamespace and c.relname = any($1)`,
        [RUNTIME_TABLES],
      );
      expect(found.rows.map((r) => r.relname).sort()).toEqual([...RUNTIME_TABLES].sort());
      expect(found.rows.every((r) => r.forced)).toBe(true);
      expect(await findRlsProblems(su)).toEqual([]);
    } finally {
      await su.end();
    }
  });

  test("have the indexes the worker and janitor need (architecture §2.3)", async () => {
    const r = await bare.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = any($1)",
      [RUNTIME_TABLES],
    );
    const defs = r.rows.map((x) => x.indexdef);
    expect(defs.some((d) => /inbound_events .*\(conversation_id\) WHERE \(processed_at IS NULL\)/.test(d))).toBe(true);
    expect(defs.some((d) => /conversations .*\(expires_at\) WHERE \(ended_at IS NULL\)/.test(d))).toBe(true);
  });
  test("the Drizzle mirrors name every column with the same nullability", async () => {
    for (const table of Object.values(runtimeTables)) {
      const name = getTableName(table);
      const r = await bare.query<{ column_name: string; is_nullable: "YES" | "NO" }>(
        "select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1",
        [name],
      );
      const inDb = Object.fromEntries(r.rows.map((c) => [c.column_name, c.is_nullable === "NO"]));
      const mirrored = Object.fromEntries(Object.values(getTableColumns(table)).map((c) => [c.name, c.notNull]));
      expect(mirrored, name).toEqual(inDb);
    }
    expect(Object.values(runtimeTables).map(getTableName).sort()).toEqual([...RUNTIME_TABLES].sort());
  });
});

describe.each(["A → B", "B → A"])("two tenants, %s", (direction) => {
  let owner: Tenant;
  let other: Tenant;
  let c: Chain;

  beforeAll(async () => {
    const a = await tenant();
    const b = await tenant();
    [owner, other] = direction === "A → B" ? [a, b] : [b, a];
    c = await chain(owner);
  });

  test.each(RUNTIME_TABLES)(
    "%s: the owner sees its row, the other tenant and a bare connection see none",
    async (table) => {
      expect(await count(owner.ws, table)).toBeGreaterThanOrEqual(1);
      expect(await count(other.ws, table)).toBe(0);
      expect((await bare.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    },
  );

  test.each(RUNTIME_TABLES)("%s: the other tenant can neither update nor delete the owner's rows", async (table) => {
    const updated = await db.withWorkspace(other.ws, (tx) =>
      tx.execute(sql.raw(`update ${table} set workspace_id = workspace_id`)),
    );
    const deleted = await db.withWorkspace(other.ws, (tx) => tx.execute(sql.raw(`delete from ${table}`)));
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    expect(await count(owner.ws, table)).toBeGreaterThanOrEqual(1);
  });

  test("the other tenant cannot write a row into the owner's workspace", async () => {
    const e = await pgError(
      db.withWorkspace(other.ws, (tx) =>
        tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
          values (${newId("conn")}, ${owner.ws}, ${owner.botId}, 'Forged', 'production')`),
      ),
    );
    expect(e.code).toBe(RLS);
  });

  test("rows cannot point at another tenant's rows, even with their ids", async () => {
    // Foreign key checks do not apply RLS, so every link is composite with workspace_id.
    const attempts = [
      sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
        values (${newId("conn")}, ${other.ws}, ${owner.botId}, 'x', 'production')`,
      sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id)
        values (${newId("eu")}, ${other.ws}, ${other.botId}, ${c.connectionId}, 'x')`,
      sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes)
        values (${newId("conv")}, ${other.ws}, ${other.botId}, ${c.connectionId}, ${c.endUserId}, 'x', 'live', 'idle', '{}'::jsonb, 2)`,
      sql`insert into inbound_events (id, workspace_id, connection_id, conversation_id, seq, kind, payload)
        values (${newId("evt")}, ${other.ws}, ${c.connectionId}, ${c.conversationId}, 99, 'message', '{}'::jsonb)`,
      sql`insert into turns (id, workspace_id, conversation_id, bot_id, trigger_event_id, status)
        values (${newId("turn")}, ${other.ws}, ${c.conversationId}, ${other.botId}, ${c.eventId}, 'running')`,
      sql`insert into messages (id, workspace_id, conversation_id, seq, direction, type, payload)
        values (${newId("msg")}, ${other.ws}, ${c.conversationId}, 99, 'out', 'text', '{}'::jsonb)`,
      sql`insert into outbox_events (id, workspace_id, connection_id, conversation_id, type, payload, ephemeral)
        values (${newId("out")}, ${other.ws}, ${c.connectionId}, ${c.conversationId}, 'typing', '{}'::jsonb, true)`,
    ];
    for (const attempt of attempts) {
      const e = await pgError(db.withWorkspace(other.ws, (tx) => tx.execute(attempt)));
      expect(e.code).toBe(FOREIGN_KEY);
    }
  });

  test("a bridge key cannot name another tenant's connection", async () => {
    const e = await pgError(
      db.withWorkspace(other.ws, (tx) =>
        tx.execute(sql`insert into api_keys (id, workspace_id, kind, name, prefix, secret_hash, connection_id)
          values (${newId("key")}, ${other.ws}, 'bridge', 'x', ${randomBytes(4).toString("hex")}, ${"0".repeat(64)}, ${c.connectionId})`),
      ),
    );
    expect(e.code).toBe(FOREIGN_KEY);
  });

  test("an API key cannot name another tenant's bot", async () => {
    const e = await pgError(
      db.withWorkspace(other.ws, (tx) =>
        tx.execute(sql`insert into api_keys (id, workspace_id, kind, name, prefix, secret_hash, bot_id)
          values (${newId("key")}, ${other.ws}, 'workspace', 'x', ${randomBytes(4).toString("hex")}, ${"0".repeat(64)}, ${owner.botId})`),
      ),
    );
    expect(e.code).toBe(FOREIGN_KEY);
  });
});

describe("unique constraints", () => {
  let t: Tenant;
  let c: Chain;

  beforeAll(async () => {
    t = await tenant();
    c = await chain(t, "user-42");
  });

  const run = (statement: ReturnType<typeof sql>) => db.withWorkspace(t.ws, (tx) => tx.execute(statement));

  test("an end user's external id is unique per connection, not across connections", async () => {
    const e = await pgError(
      run(sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id)
        values (${newId("eu")}, ${t.ws}, ${t.botId}, ${c.connectionId}, 'user-42')`),
    );
    expect(e.code).toBe(UNIQUE);
    const second = await chain(t, "user-42");
    expect(second.endUserId).not.toBe(c.endUserId);
  });

  test("a conversation's external id is unique per connection", async () => {
    const e = await pgError(
      run(sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes)
        values (${newId("conv")}, ${t.ws}, ${t.botId}, ${c.connectionId}, ${c.endUserId}, 'user-42', 'live', 'idle', '{}'::jsonb, 2)`),
    );
    expect(e.code).toBe(UNIQUE);
  });

  test("an idempotency key is unique per connection; events without one are not limited", async () => {
    const e = await pgError(
      run(sql`insert into inbound_events (id, workspace_id, connection_id, conversation_id, seq, kind, payload, idempotency_key)
        values (${newId("evt")}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 2, 'message', '{}'::jsonb, 'idem-user-42')`),
    );
    expect(e.code).toBe(UNIQUE);
    for (const seq of [2, 3]) {
      await run(sql`insert into inbound_events (id, workspace_id, connection_id, conversation_id, seq, kind, payload)
        values (${newId("evt")}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, ${seq}, 'user_update', '{}'::jsonb)`);
    }
  });

  test("an inbound sequence number is unique per conversation", async () => {
    const e = await pgError(
      run(sql`insert into inbound_events (id, workspace_id, connection_id, conversation_id, seq, kind, payload)
        values (${newId("evt")}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 1, 'message', '{}'::jsonb)`),
    );
    expect(e.code).toBe(UNIQUE);
  });

  test("an outbound sequence number is unique per conversation; ephemeral events have none", async () => {
    const e = await pgError(
      run(sql`insert into outbox_events (id, workspace_id, connection_id, conversation_id, seq, type, payload, ephemeral)
        values (${newId("out")}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 1, 'turn.completed', '{}'::jsonb, false)`),
    );
    expect(e.code).toBe(UNIQUE);
    for (let i = 0; i < 2; i++) {
      await run(sql`insert into outbox_events (id, workspace_id, connection_id, conversation_id, type, payload, ephemeral)
        values (${newId("out")}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 'typing', '{}'::jsonb, true)`);
    }
  });

  test("a message id written twice is refused, so a retried step cannot duplicate output", async () => {
    const e = await pgError(
      run(sql`insert into messages (id, workspace_id, conversation_id, seq, direction, type, payload)
        values (${c.messageId}, ${t.ws}, ${c.conversationId}, 2, 'out', 'text', '{}'::jsonb)`),
    );
    expect(e.code).toBe(UNIQUE);
  });
});

describe("checks", () => {
  let t: Tenant;
  let c: Chain;

  beforeAll(async () => {
    t = await tenant();
    c = await chain(t);
  });

  const refused = async (statement: ReturnType<typeof sql>) =>
    (await pgError(db.withWorkspace(t.ws, (tx) => tx.execute(statement)))).code;

  test("enumerated columns accept only their documented values", async () => {
    expect(
      await refused(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
        values (${newId("conn")}, ${t.ws}, ${t.botId}, 'x', 'staging')`),
    ).toBe(CHECK);
    expect(await refused(sql`update bridge_connections set status = 'deleted' where id = ${c.connectionId}`)).toBe(
      CHECK,
    );
    expect(await refused(sql`update conversations set mode = 'test' where id = ${c.conversationId}`)).toBe(CHECK);
    expect(await refused(sql`update conversations set status = 'busy' where id = ${c.conversationId}`)).toBe(CHECK);
    expect(await refused(sql`update conversations set ended_reason = 'bored' where id = ${c.conversationId}`)).toBe(
      CHECK,
    );
    expect(await refused(sql`update inbound_events set kind = 'poke' where id = ${c.eventId}`)).toBe(CHECK);
    expect(await refused(sql`update turns set status = 'paused' where id = ${c.turnId}`)).toBe(CHECK);
    expect(await refused(sql`update messages set direction = 'both' where id = ${c.messageId}`)).toBe(CHECK);
    expect(await refused(sql`update outbox_events set type = 'message.deleted' where id = ${c.outboxId}`)).toBe(CHECK);
  });

  test("ids must carry their own prefix (ADR-012)", async () => {
    expect(
      await refused(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
        values (${newId("bot")}, ${t.ws}, ${t.botId}, 'x', 'production')`),
    ).toBe(CHECK);
  });

  test("an ephemeral outbox event has no sequence number and an ordered one must have one", async () => {
    expect(
      await refused(sql`insert into outbox_events (id, workspace_id, connection_id, conversation_id, seq, type, payload, ephemeral)
        values (${newId("out")}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 7, 'typing', '{}'::jsonb, true)`),
    ).toBe(CHECK);
    expect(
      await refused(sql`insert into outbox_events (id, workspace_id, connection_id, conversation_id, type, payload, ephemeral)
        values (${newId("out")}, ${t.ws}, ${c.connectionId}, ${c.conversationId}, 'message.created', '{}'::jsonb, false)`),
    ).toBe(CHECK);
  });

  test("JSON columns hold the documented shape", async () => {
    expect(await refused(sql`update conversations set state = '[]'::jsonb where id = ${c.conversationId}`)).toBe(CHECK);
    expect(await refused(sql`update end_users set attributes = '"x"'::jsonb where id = ${c.endUserId}`)).toBe(CHECK);
    expect(
      await refused(sql`update bridge_connections set signing_secrets = '{}'::jsonb where id = ${c.connectionId}`),
    ).toBe(CHECK);
  });

  test("a bridge key must name a connection that exists", async () => {
    expect(
      await refused(sql`insert into api_keys (id, workspace_id, kind, name, prefix, secret_hash, connection_id)
        values (${newId("key")}, ${t.ws}, 'bridge', 'x', ${randomBytes(4).toString("hex")}, ${"0".repeat(64)}, ${newId("conn")})`),
    ).toBe(FOREIGN_KEY);
  });

  test("defaults: a new connection is active with no secrets; a conversation starts its counters at 1", async () => {
    const rows = await db.withWorkspace(t.ws, async (tx) => {
      const conn = await tx.execute(
        sql`select status, signing_secrets, subscribed_events, consecutive_dead from bridge_connections where id = ${c.connectionId}`,
      );
      const conv = await tx.execute(
        sql`select next_in_seq, next_out_seq, lease_epoch, last_activity_at is not null as active from conversations where id = ${c.conversationId}`,
      );
      return { conn: conn.rows[0], conv: conv.rows[0] };
    });
    expect(rows.conn).toEqual({ status: "active", signing_secrets: [], subscribed_events: [], consecutive_dead: 0 });
    expect(rows.conv).toEqual({ next_in_seq: "1", next_out_seq: "1", lease_epoch: "0", active: true });
  });
});

describe("deleting", () => {
  test("a bot takes its connections, users, conversations and their history with it", async () => {
    const t = await tenant();
    await chain(t);
    await db.withWorkspace(t.ws, (tx) => deleteBot(tx, t.botId));
    for (const table of RUNTIME_TABLES) expect(await count(t.ws, table)).toBe(0);
  });

  test("a connection takes its bridge keys with it, and a bot with bridge keys can still be deleted", async () => {
    const t = await tenant();
    const c = await chain(t);
    const keys = () =>
      db.withWorkspace(t.ws, async (tx) => {
        const r = await tx.execute(sql`select count(*)::int as n from api_keys where kind = 'bridge'`);
        return (r.rows[0] as { n: number }).n;
      });
    const insertKey = (connectionId: string) =>
      db.withWorkspace(t.ws, (tx) =>
        tx.execute(sql`insert into api_keys (id, workspace_id, kind, name, prefix, secret_hash, bot_id, connection_id)
          values (${newId("key")}, ${t.ws}, 'bridge', 'Website', ${randomBytes(4).toString("hex")}, ${"0".repeat(64)}, ${t.botId}, ${connectionId})`),
      );
    await insertKey(c.connectionId);
    await db.withWorkspace(t.ws, (tx) => tx.execute(sql`delete from bridge_connections where id = ${c.connectionId}`));
    expect(await keys()).toBe(0);

    const again = await chain(t);
    await insertKey(again.connectionId);
    await db.withWorkspace(t.ws, (tx) => deleteBot(tx, t.botId));
    expect(await keys()).toBe(0);
  });
});
