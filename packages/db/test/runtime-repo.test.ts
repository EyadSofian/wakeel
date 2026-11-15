import { randomBytes } from "node:crypto";
import { emptyState, newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  acquireConversationLease,
  appendInboundEvent,
  appendOutbox,
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  eventsOfTurn,
  finishTurn,
  getConversation,
  getEndUser,
  insertBotMessages,
  LeaseLostError,
  nextUnprocessedEvent,
  releaseConversationLease,
  renewConversationLease,
  runningTurnFor,
  sql,
  startTurn,
  unprocessedEventsAfter,
  updateEndUser,
  writeConversation,
} from "../src/index";

/** Task 4.4: the turn worker's repository and lookups (migration 0006), against real Postgres. */
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

async function conversation(status = "idle") {
  const userId = newId("usr");
  await su.query("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Turns",
    slug: `t-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "النور", slug: "noor", createdBy: userId }));
  const ids = { ws, botId: bot.id, connectionId: newId("conn"), endUserId: newId("eu"), conversationId: newId("conv") };
  await db.withWorkspace(ws, async (tx) => {
    await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
      values (${ids.connectionId}, ${ws}, ${ids.botId}, 'Website', 'draft')`);
    await tx.execute(sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id, attributes)
      values (${ids.endUserId}, ${ws}, ${ids.botId}, ${ids.connectionId}, 'u-1', '{"name":"منى"}'::jsonb)`);
    await tx.execute(sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes)
      values (${ids.conversationId}, ${ws}, ${ids.botId}, ${ids.connectionId}, ${ids.endUserId}, 'c-1', 'live', ${status}, ${JSON.stringify({ ...emptyState(), status })}::jsonb, 10)`);
  });
  return ids;
}

type Ids = Awaited<ReturnType<typeof conversation>>;
const expireLease = (id: string) =>
  su.query("update conversations set lease_until = now() - interval '1 second' where id = $1", [id]);
const inbound = (
  c: Ids,
  kind = "message",
  payload: Record<string, unknown> = { message: { type: "text", text: "مرحبا" } },
) =>
  db.withWorkspace(c.ws, (tx) =>
    appendInboundEvent(tx, { conversationId: c.conversationId, kind, payload: payload as never }),
  );

describe("the lease", () => {
  test("one worker at a time; a lapsed lease can be taken, and the old epoch is fenced out", async () => {
    const c = await conversation();
    const take = (owner: string) =>
      db.withWorkspace(c.ws, (tx) => acquireConversationLease(tx, c.conversationId, owner, 30_000));
    expect(await take("worker-a")).toBe(1);
    expect(await take("worker-b")).toBeUndefined();
    await expireLease(c.conversationId);
    expect(await take("worker-b")).toBe(2);

    // Worker A comes back with epoch 1: every fenced write fails.
    const write = (epoch: number) =>
      db.withWorkspace(c.ws, (tx) => writeConversation(tx, c.conversationId, epoch, { touchActivity: true }));
    await expect(write(1)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(write(2)).resolves.toBeUndefined();
    expect(await db.withWorkspace(c.ws, (tx) => renewConversationLease(tx, c.conversationId, 1, 30_000))).toBe(false);
    expect(await db.withWorkspace(c.ws, (tx) => renewConversationLease(tx, c.conversationId, 2, 30_000))).toBe(true);

    // Releasing with the old epoch leaves the live lease alone.
    await db.withWorkspace(c.ws, (tx) => releaseConversationLease(tx, c.conversationId, 1));
    expect(await take("worker-c")).toBeUndefined();
    await db.withWorkspace(c.ws, (tx) => releaseConversationLease(tx, c.conversationId, 2));
    expect(await take("worker-c")).toBe(3);
  });

  test("outbox and turn writes are fenced too", async () => {
    const c = await conversation();
    const epoch = (await db.withWorkspace(c.ws, (tx) =>
      acquireConversationLease(tx, c.conversationId, "a", 30_000),
    )) as number;
    const e = await inbound(c);
    await expireLease(c.conversationId);
    await db.withWorkspace(c.ws, (tx) => acquireConversationLease(tx, c.conversationId, "b", 30_000));
    const at = { conversationId: c.conversationId, connectionId: c.connectionId, epoch };
    await expect(
      db.withWorkspace(c.ws, (tx) => appendOutbox(tx, at, [{ type: "typing", payload: {}, ephemeral: false }])),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      db.withWorkspace(c.ws, (tx) =>
        startTurn(tx, { conversationId: c.conversationId, botId: c.botId, versionId: null, epoch, eventIds: [e.id] }),
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe("the inbox, turns, transcript and outbox", () => {
  test("events drain in seq order; a turn groups its events; finishing marks them processed", async () => {
    const c = await conversation();
    const first = await inbound(c);
    const second = await inbound(c, "message", { message: { type: "text", text: "تاني" } });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    const epoch = (await db.withWorkspace(c.ws, (tx) =>
      acquireConversationLease(tx, c.conversationId, "a", 30_000),
    )) as number;
    await db.withWorkspace(c.ws, async (tx) => {
      expect((await nextUnprocessedEvent(tx, c.conversationId))?.id).toBe(first.id);
      expect((await unprocessedEventsAfter(tx, c.conversationId, 1)).map((e) => e.id)).toEqual([second.id]);
      const turn = await startTurn(tx, {
        conversationId: c.conversationId,
        botId: c.botId,
        versionId: null,
        epoch,
        eventIds: [first.id, second.id],
      });
      expect((await runningTurnFor(tx, first.id))?.id).toBe(turn.id);
      expect((await eventsOfTurn(tx, turn.id)).map((e) => e.seq)).toEqual([1, 2]);
      await finishTurn(tx, { turnId: turn.id, status: "completed", stepCount: 2 });
      expect(await runningTurnFor(tx, first.id)).toBeUndefined();
      expect(await nextUnprocessedEvent(tx, c.conversationId)).toBeUndefined();
    });
  });

  test("bot messages take increasing seq from the transcript sequence, after a user message", async () => {
    const c = await conversation();
    await db.withWorkspace(c.ws, async (tx) => {
      // A user message as the Bridge API (4.5) will write it: no seq given.
      await tx.execute(sql`insert into messages (id, workspace_id, conversation_id, direction, type, payload)
        values (${newId("msg")}, ${c.ws}, ${c.conversationId}, 'in', 'text', '{"type":"text","text":"مرحبا"}'::jsonb)`);
    });
    const epoch = (await db.withWorkspace(c.ws, (tx) =>
      acquireConversationLease(tx, c.conversationId, "a", 30_000),
    )) as number;
    const e = await inbound(c);
    const rows = await db.withWorkspace(c.ws, async (tx) => {
      const turn = await startTurn(tx, {
        conversationId: c.conversationId,
        botId: c.botId,
        versionId: null,
        epoch,
        eventIds: [e.id],
      });
      return insertBotMessages(tx, c.conversationId, [
        { id: newId("msg"), type: "text", payload: { type: "text", text: "أهلاً" }, turnId: turn.id },
        { id: newId("msg"), type: "text", payload: { type: "text", text: "إزاي أساعدك؟" }, turnId: turn.id },
      ]);
    });
    const all = await db.withWorkspace(c.ws, async (tx) => {
      const r = await tx.execute(
        sql`select seq, direction from messages where conversation_id = ${c.conversationId} order by seq`,
      );
      return r.rows as { seq: string; direction: string }[];
    });
    expect(all.map((r) => r.direction)).toEqual(["in", "out", "out"]);
    expect(rows[1]?.seq).toBeGreaterThan(rows[0]?.seq as number);
  });

  test("ordered outbox events take consecutive seq; ephemeral ones take none", async () => {
    const c = await conversation();
    const epoch = (await db.withWorkspace(c.ws, (tx) =>
      acquireConversationLease(tx, c.conversationId, "a", 30_000),
    )) as number;
    const at = { conversationId: c.conversationId, connectionId: c.connectionId, epoch };
    await db.withWorkspace(c.ws, (tx) =>
      appendOutbox(tx, at, [
        { type: "message.created", payload: {} },
        { type: "typing", payload: { data: { state: "on" } }, ephemeral: true },
        { type: "turn.completed", payload: {} },
      ]),
    );
    await db.withWorkspace(c.ws, (tx) => appendOutbox(tx, at, [{ type: "conversation.ended", payload: {} }]));
    const rows = await db.withWorkspace(c.ws, async (tx) => {
      const r = await tx.execute(
        sql`select type, seq from outbox_events where conversation_id = ${c.conversationId} order by created_at, seq nulls first`,
      );
      return r.rows as { type: string; seq: string | null }[];
    });
    expect(rows.map((r) => [r.type, r.seq === null ? null : Number(r.seq)])).toEqual([
      ["typing", null],
      ["message.created", 1],
      ["turn.completed", 2],
      ["conversation.ended", 3],
    ]);
  });

  test("conversation writes parse the state and set the inactivity deadline from the last activity", async () => {
    const c = await conversation();
    const epoch = (await db.withWorkspace(c.ws, (tx) =>
      acquireConversationLease(tx, c.conversationId, "a", 30_000),
    )) as number;
    await db.withWorkspace(c.ws, (tx) =>
      writeConversation(tx, c.conversationId, epoch, {
        state: { ...emptyState(), status: "ended" },
        stateBytes: 40,
        endedReason: "inactivity",
        touchActivity: true,
        timeoutMinutes: 30,
      }),
    );
    const row = (
      await su.query(
        "select status, ended_reason, ended_at is not null as ended, expires_at - last_activity_at as gap from conversations where id = $1",
        [c.conversationId],
      )
    ).rows[0];
    expect(row).toMatchObject({ status: "ended", ended_reason: "inactivity", ended: true });
    expect(row.gap).toMatchObject({ minutes: 30 });
    await db.withWorkspace(c.ws, (tx) => writeConversation(tx, c.conversationId, epoch, { timeoutMinutes: 0 }));
    expect(
      (await su.query("select expires_at from conversations where id = $1", [c.conversationId])).rows[0].expires_at,
    ).toBeNull();
    const conv = await db.withWorkspace(c.ws, (tx) => getConversation(tx, c.conversationId));
    expect(conv.state.status).toBe("ended");
  });

  test("end-user variables and attributes are replaced whole", async () => {
    const c = await conversation();
    await db.withWorkspace(c.ws, (tx) => updateEndUser(tx, c.endUserId, { vars: { var_AAAAAAAAAA: 3 } }));
    await db.withWorkspace(c.ws, (tx) => updateEndUser(tx, c.endUserId, {}));
    const user = await db.withWorkspace(c.ws, (tx) => getEndUser(tx, c.endUserId));
    expect(user).toMatchObject({ vars: { var_AAAAAAAAAA: 3 }, attributes: { name: "منى" } });
  });
});

describe("two tenants", () => {
  test("another workspace can neither lease, read, write nor feed the conversation", async () => {
    const a = await conversation();
    const b = await conversation();
    await db.withWorkspace(b.ws, async (tx) => {
      expect(await acquireConversationLease(tx, a.conversationId, "intruder", 30_000)).toBeUndefined();
      await expect(getConversation(tx, a.conversationId)).rejects.toMatchObject({ code: "not_found" });
      await expect(getEndUser(tx, a.endUserId)).rejects.toMatchObject({ code: "not_found" });
      expect(await nextUnprocessedEvent(tx, a.conversationId)).toBeUndefined();
    });
    await expect(
      db.withWorkspace(b.ws, (tx) => writeConversation(tx, a.conversationId, 1, { touchActivity: true })),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      db.withWorkspace(b.ws, (tx) =>
        appendInboundEvent(tx, { conversationId: a.conversationId, kind: "timeout", payload: {} }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      db.withWorkspace(b.ws, (tx) =>
        insertBotMessages(tx, a.conversationId, [
          { id: newId("msg"), type: "text", payload: {}, turnId: newId("turn") },
        ]),
      ),
    ).rejects.toThrow();
    // A's own view is unchanged.
    const conv = await db.withWorkspace(a.ws, (tx) => getConversation(tx, a.conversationId));
    expect(conv.leaseEpoch).toBe(0);
  });
});

describe("lookups for the worker and janitor", () => {
  test("a conversation id leads to its workspace, from any connection", async () => {
    const a = await conversation();
    expect(await db.lookup.conversationWorkspace(a.conversationId)).toBe(a.ws);
    expect(await db.lookup.conversationWorkspace(newId("conv"))).toBeUndefined();
  });

  test("conversations to wake: unprocessed events and no live lease", async () => {
    const idle = await conversation();
    const pending = await conversation();
    const leased = await conversation();
    await inbound(pending);
    await inbound(leased);
    await db.withWorkspace(leased.ws, (tx) => acquireConversationLease(tx, leased.conversationId, "a", 30_000));
    const woken = (await db.lookup.conversationsToWake(10_000)).map((r) => r.conversationId);
    expect(woken).toContain(pending.conversationId);
    expect(woken).not.toContain(leased.conversationId);
    expect(woken).not.toContain(idle.conversationId);
    expect(
      (await db.lookup.conversationsToWake(10_000)).find((r) => r.conversationId === pending.conversationId),
    ).toEqual({
      conversationId: pending.conversationId,
      workspaceId: pending.ws,
    });
  });

  test("expired conversations: waiting, past the deadline, no timeout pending", async () => {
    const waiting = await conversation("waiting_input");
    const idle = await conversation("idle");
    const pending = await conversation("waiting_external");
    for (const c of [waiting, idle, pending])
      await su.query("update conversations set expires_at = now() - interval '1 minute' where id = $1", [
        c.conversationId,
      ]);
    await inbound(pending, "timeout", {});
    const expired = (await db.lookup.conversationsExpired(10_000)).map((r) => r.conversationId);
    expect(expired).toContain(waiting.conversationId);
    expect(expired).not.toContain(idle.conversationId);
    expect(expired).not.toContain(pending.conversationId);
  });

  test("the lookups are owned by app_lookup and only app_rw may run them", async () => {
    const r = await su.query<{ name: string; owner: string; public_exec: boolean; rw_exec: boolean }>(
      `select p.proname as name, pg_get_userbyid(p.proowner) as owner,
              has_function_privilege('public', p.oid, 'execute') as public_exec,
              has_function_privilege('app_rw', p.oid, 'execute') as rw_exec
       from pg_proc p where p.pronamespace = 'lookup'::regnamespace
         and p.proname in ('conversation_workspace', 'conversations_to_wake', 'conversations_expired')`,
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) expect(row).toMatchObject({ owner: "app_lookup", public_exec: false, rw_exec: true });
  });
});
