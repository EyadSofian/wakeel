import { randomBytes } from "node:crypto";
import { emptyState, newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  ensureConversation,
  ensureEmulatorConnection,
  insertInbound,
  sql,
  upsertEndUser,
} from "../src/index";

/** Task 4.6 (ADR-025, migration 0007): the emulator's draft connection per builder session. */
const urls = inject("db");
let db: Database;
let su: pg.Client;

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  su = new pg.Client({ connectionString: urls.superuser });
  await su.connect();
});

afterAll(async () => {
  await su?.end();
  await db?.close();
});

async function builder() {
  const userId = newId("usr");
  await su.query("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const session = async () => {
    const id = newId("ses");
    await su.query(
      "insert into sessions (id, user_id, token, expires_at) values ($1, $2, $3, now() + interval '1 day')",
      [id, userId, randomBytes(16).toString("hex")],
    );
    return id;
  };
  const { workspace } = await createWorkspace(db, {
    name: "Emulator",
    slug: `e-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const bot = await db.withWorkspace(workspace.id, (tx) =>
    createBot(tx, { name: "النور", slug: "noor", createdBy: userId }),
  );
  return { ws: workspace.id, botId: bot.id, userId, session };
}

describe("ensureEmulatorConnection", () => {
  test("creates one draft connection per session and bot, and returns it again after", async () => {
    const b = await builder();
    const s1 = await b.session();
    const first = await db.withWorkspace(b.ws, (tx) => ensureEmulatorConnection(tx, { botId: b.botId, sessionId: s1 }));
    const again = await db.withWorkspace(b.ws, (tx) => ensureEmulatorConnection(tx, { botId: b.botId, sessionId: s1 }));
    expect(first).toMatchObject({ botId: b.botId, target: "draft", status: "active", name: "Emulator" });
    expect(again.id).toBe(first.id);

    const s2 = await b.session();
    const other = await db.withWorkspace(b.ws, (tx) => ensureEmulatorConnection(tx, { botId: b.botId, sessionId: s2 }));
    expect(other.id).not.toBe(first.id);
  });

  test("two at once for the same session give one connection", async () => {
    const b = await builder();
    const s = await b.session();
    const [x, y] = await Promise.all([
      db.withWorkspace(b.ws, (tx) => ensureEmulatorConnection(tx, { botId: b.botId, sessionId: s })),
      db.withWorkspace(b.ws, (tx) => ensureEmulatorConnection(tx, { botId: b.botId, sessionId: s })),
    ]);
    expect(x.id).toBe(y.id);
  });

  test("removing the session removes the connection and its test conversations", async () => {
    const b = await builder();
    const s = await b.session();
    const conn = await db.withWorkspace(b.ws, (tx) => ensureEmulatorConnection(tx, { botId: b.botId, sessionId: s }));
    const convId = await db.withWorkspace(b.ws, async (tx) => {
      const user = await upsertEndUser(tx, {
        connectionId: conn.id,
        botId: b.botId,
        externalId: "test-user",
        patch: {},
      });
      const conv = await ensureConversation(tx, {
        connectionId: conn.id,
        botId: b.botId,
        endUserId: user.id,
        externalId: "emu-1",
        mode: "emulator",
        state: emptyState() as never,
        stateBytes: 10,
      });
      await insertInbound(tx, {
        conversationId: conv.id,
        kind: "run_from",
        payload: { workflowId: "wf", nodeId: "n" },
      });
      return conv.id;
    });
    await su.query("delete from sessions where id = $1", [s]);
    const [left] = (
      await su.query(
        `select (select count(*)::int from bridge_connections where id = $1) as connections,
                (select count(*)::int from conversations where id = $2) as conversations`,
        [conn.id, convId],
      )
    ).rows;
    expect(left).toEqual({ connections: 0, conversations: 0 });
  });

  test("an emulator connection must run the draft", async () => {
    const b = await builder();
    const s = await b.session();
    const error = await db
      .withWorkspace(b.ws, (tx) =>
        tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target, emulator_session_id)
          values (${newId("conn")}, ${b.ws}, ${b.botId}, 'Emulator', 'production', ${s})`),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    // Drizzle wraps the driver's error; the constraint name is on its cause.
    expect((error as { cause?: { constraint?: string } })?.cause?.constraint).toBe(
      "bridge_connections_emulator_is_draft",
    );
  });
});

describe("two tenants", () => {
  test("another workspace cannot see or reuse an emulator connection, nor attach one to the bot", async () => {
    const a = await builder();
    const other = await builder();
    const s = await a.session();
    const conn = await db.withWorkspace(a.ws, (tx) => ensureEmulatorConnection(tx, { botId: a.botId, sessionId: s }));
    const seen = await db.withWorkspace(
      other.ws,
      async (tx) => (await tx.execute(sql`select id from bridge_connections where id = ${conn.id}`)).rows.length,
    );
    expect(seen).toBe(0);
    await expect(
      db.withWorkspace(other.ws, (tx) => ensureEmulatorConnection(tx, { botId: a.botId, sessionId: s })),
    ).rejects.toThrow();
  });
});
