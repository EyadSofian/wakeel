import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { parseSignatureHeader, verifySignature } from "@wakeel/bridge";
import { type BridgeEvent, emptyState, newId } from "@wakeel/contracts";
import {
  appendOutbox,
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  DEAD_EVENTS_TO_DISABLE,
  replayDelivery,
  setSigningSecrets,
  sql,
} from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import { createLogger } from "@wakeel/telemetry";
import { FakeClock } from "@wakeel/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runJanitor } from "../src/turn/index";
import { deliverConversation, type SendResult, type WebhookDeps, type WebhookSender } from "../src/webhook/index";

/**
 * Task 5.2: the delivery worker against real Postgres, with the fake clock and a scripted receiver.
 * Acceptance (build plan): order preserved under retries; a dead-lettered event unblocks the stream
 * with a gap; a slow receiver for conversation A does not delay B.
 */

let database: StartedTestDatabase;
let db: Database;

const logger = createLogger({
  service: "worker",
  level: "silent",
  destination: new Writable({ write: (_c, _e, d) => d() }),
});
const keyring = { current: { version: 1, key: new Uint8Array(randomBytes(32)) } };
const SECRETS = ["whsec_current_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "whsec_previous_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"];

beforeAll(async () => {
  database = await startTestDatabase();
  db = createDatabase({ url: database.urls.rw, maxConnections: 8 });
});

afterAll(async () => {
  await db?.close();
  await database?.stop();
});

const su = (q: string, params: unknown[] = []) => superuserQuery(database.urls, q, params);

interface Setup {
  url?: string;
  secrets?: string[];
}

/** A live conversation on a connection with a webhook and two signing secrets; lease epoch 1. */
async function conversation(setup: Setup = {}) {
  const userId = newId("usr");
  await su("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Webhooks",
    slug: `w-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "النور", slug: "noor", createdBy: userId }));
  const ids = { ws, botId: bot.id, conn: newId("conn"), eu: newId("eu"), conv: newId("conv") };
  const url = setup.url ?? `https://receiver.example.test/${ids.conv}`;
  await db.withWorkspace(ws, async (tx) => {
    await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target, webhook_url, subscribed_events)
      values (${ids.conn}, ${ws}, ${ids.botId}, 'Chatwoot', 'production', ${url},
        array['message.created', 'typing', 'turn.completed']::text[])`);
    await tx.execute(sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id)
      values (${ids.eu}, ${ws}, ${ids.botId}, ${ids.conn}, 'cw_contact_812')`);
    await tx.execute(sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes, lease_epoch)
      values (${ids.conv}, ${ws}, ${ids.botId}, ${ids.conn}, ${ids.eu}, 'cw_conv_3391', 'live', 'idle', ${JSON.stringify(emptyState())}::jsonb, 10, 1)`);
    await setSigningSecrets(tx, keyring, {
      workspaceId: ws,
      connectionId: ids.conn,
      secrets: setup.secrets ?? SECRETS,
    });
  });
  return { ...ids, url };
}

type Conv = Awaited<ReturnType<typeof conversation>>;

/** Writes events as the turn worker does: `count` messages (seq 1…), optionally a typing event first. */
async function events(c: Conv, clock: FakeClock, count: number, typing = false) {
  const message = (i: number) => ({
    type: "message.created",
    payload: {
      turnId: newId("turn"),
      data: {
        message: {
          id: newId("msg"),
          conversationId: c.conv,
          seq: i,
          direction: "out",
          payload: { type: "text", text: `رسالة رقم ${i}`, format: "markdown" },
          citations: [],
          createdAt: clock.iso(),
        },
      },
    },
  });
  await db.withWorkspace(c.ws, (tx) =>
    appendOutbox(tx, { conversationId: c.conv, connectionId: c.conn, epoch: 1, at: clock.date() }, [
      ...(typing ? [{ type: "typing", payload: { data: { state: "on" } }, ephemeral: true }] : []),
      ...Array.from({ length: count }, (_, i) => message(i + 1)),
    ]),
  );
  // created_at is the database's own time; tests run on the fake clock.
  await su("update outbox_events set created_at = $2 where conversation_id = $1", [c.conv, clock.date()]);
}

interface Call {
  url: string;
  workspaceId: string;
  headers: Record<string, string>;
  raw: string;
  event: BridgeEvent;
}

/** A receiver that answers from `script` (by event seq and attempt) and records every call. */
function receiver(
  script: (call: Call) => SendResult | Promise<SendResult> = () => ({ kind: "response", status: 200 }),
) {
  const calls: Call[] = [];
  const sender: WebhookSender = {
    send: async (req) => {
      const call: Call = { ...req, raw: req.body, event: JSON.parse(req.body) as BridgeEvent };
      calls.push(call);
      return script(call);
    },
  };
  return { sender, calls };
}

const attemptOf = (c: Call) => Number(c.headers["X-Wakeel-Delivery-Attempt"]);
const seqOf = (c: Call) => c.event.seq ?? null;

function deps(clock: FakeClock, sender: WebhookSender) {
  const wakes: { conversationId: string; deliveryId: string; at: Date }[] = [];
  const d: WebhookDeps = {
    db,
    logger,
    sender,
    keyring,
    clock,
    random: () => 0.5,
    scheduleWake: async (conversationId, deliveryId, at) => {
      wakes.push({ conversationId, deliveryId, at });
    },
  };
  return { d, wakes };
}

/** Runs the stream until it is drained, advancing the fake clock to each scheduled retry. */
async function untilDrained(d: WebhookDeps, clock: FakeClock, wakes: { at: Date }[], conversationId: string) {
  for (let i = 0; i < 20; i++) {
    const r = await deliverConversation(d, conversationId);
    if (r.stopped !== "waiting") return r;
    const at = wakes.at(-1)?.at as Date;
    await clock.advance(at.getTime() - clock.now());
  }
  throw new Error("the stream never drained");
}

const rows = async (c: Conv) =>
  (await su(
    `select d.seq, d.attempt, d.status, d.response_status, d.error->>'code' as code, d.ephemeral
       from webhook_deliveries d where d.conversation_id = $1 order by d.seq nulls first, d.attempt`,
    [c.conv],
  )) as { seq: string | null; attempt: number; status: string; response_status: number | null; code: string | null }[];

const connection = async (c: Conv) =>
  (
    (await su("select status, consecutive_dead from bridge_connections where id = $1", [c.conn])) as {
      status: string;
      consecutive_dead: number;
    }[]
  )[0];

describe("one stream", () => {
  test("delivers every event in seq order, signed with both secrets, with the Bridge event as body", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 3);
    const r = receiver();
    const { d } = deps(clock, r.sender);

    expect(await deliverConversation(d, c.conv)).toEqual({ sent: 3, stopped: "drained" });
    expect(r.calls.map(seqOf)).toEqual([1, 2, 3]);
    const first = r.calls[0] as Call;
    expect(first.url).toBe(c.url);
    expect(first.workspaceId).toBe(c.ws);
    expect(first.event).toMatchObject({
      type: "message.created",
      connectionId: c.conn,
      botId: c.botId,
      conversation: { id: c.conv, externalId: "cw_conv_3391" },
      user: { id: c.eu, externalId: "cw_contact_812" },
      seq: 1,
      ephemeral: false,
    });
    expect(first.event.id).toMatch(/^evt_/);
    expect(first.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Wakeel-Event-Id": first.event.id,
      "X-Wakeel-Delivery-Attempt": "1",
    });
    // A receiver holding either secret accepts the body exactly as sent.
    const header = first.headers["X-Wakeel-Signature"] as string;
    expect(parseSignatureHeader(header)?.signatures).toHaveLength(2);
    for (const secret of SECRETS) {
      expect(
        verifySignature({ header, rawBody: first.raw, secrets: [secret], nowSeconds: clock.now() / 1000 }),
      ).toEqual({ ok: true });
    }
    expect((await rows(c)).map((x) => x.status)).toEqual(["delivered", "delivered", "delivered"]);
  });

  test("order is preserved under retries: event 2 waits until event 1 succeeds", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 3);
    const r = receiver((call) =>
      seqOf(call) === 1 && attemptOf(call) < 3 ? { kind: "response", status: 503 } : { kind: "response", status: 200 },
    );
    const { d, wakes } = deps(clock, r.sender);

    expect(await deliverConversation(d, c.conv)).toEqual({ sent: 1, stopped: "waiting" });
    // The first retry is due 5 s later (no jitter at random = 0.5).
    expect(wakes.at(-1)?.at.toISOString()).toBe("2026-11-14T10:00:05.000Z");
    expect(r.calls.map(seqOf)).toEqual([1]);

    await untilDrained(d, clock, wakes, c.conv);
    expect(r.calls.map((x) => [seqOf(x), attemptOf(x)])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [3, 1],
    ]);
    expect((await rows(c)).map((x) => [x.seq, x.attempt, x.status, x.response_status])).toEqual([
      ["1", 1, "failed", 503],
      ["1", 2, "failed", 503],
      ["1", 3, "delivered", 200],
      ["2", 1, "delivered", 200],
      ["3", 1, "delivered", 200],
    ]);
  });

  test("a dead-lettered event unblocks the stream and leaves a seq gap", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 2);
    const r = receiver((call) =>
      seqOf(call) === 1 ? { kind: "response", status: 500 } : { kind: "response", status: 200 },
    );
    const { d, wakes } = deps(clock, r.sender);

    await untilDrained(d, clock, wakes, c.conv);
    const attempts = r.calls.filter((x) => seqOf(x) === 1).map(attemptOf);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // About 21 hours of retries (§9.2), then event 2.
    expect(clock.now() - Date.parse("2026-11-14T10:00:00.000Z")).toBe(
      (5 + 30 + 120 + 600 + 1_800 + 7_200 + 21_600 + 43_200) * 1000,
    );
    expect(r.calls.at(-1) && seqOf(r.calls.at(-1) as Call)).toBe(2);
    const all = await rows(c);
    expect(all.filter((x) => x.seq === "1").at(-1)).toMatchObject({
      attempt: 9,
      status: "dead",
      code: "webhook_rejected",
    });
    expect(all.filter((x) => x.seq === "2")).toMatchObject([{ attempt: 1, status: "delivered" }]);
    // One dead event, then a delivery: the run of dead events is broken.
    expect(await connection(c)).toEqual({ status: "active", consecutive_dead: 0 });
  });
});

describe("streams are independent", () => {
  test("a slow receiver for conversation A does not delay conversation B", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const a = await conversation();
    const b = await conversation();
    await events(a, clock, 2);
    await events(b, clock, 2);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = receiver(async (call) => {
      if (call.url === a.url) await gate;
      return { kind: "response", status: 200 };
    });
    const { d } = deps(clock, r.sender);

    const slow = deliverConversation(d, a.conv);
    // B is delivered in full while A's first call is still open.
    expect(await deliverConversation(d, b.conv)).toEqual({ sent: 2, stopped: "drained" });
    // A second sender for A finds its head leased and leaves it alone.
    expect(await deliverConversation(d, a.conv)).toEqual({ sent: 0, stopped: "busy" });
    expect(r.calls.filter((x) => x.url === a.url)).toHaveLength(1);

    release();
    expect(await slow).toEqual({ sent: 2, stopped: "drained" });
    expect(r.calls.filter((x) => x.url === a.url).map(seqOf)).toEqual([1, 2]);
  });
});

describe("ephemeral events", () => {
  test("go out before a blocked head, once, and a failure is not retried", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 1, true);
    const r = receiver(() => ({ kind: "response", status: 500 }));
    const { d } = deps(clock, r.sender);

    expect(await deliverConversation(d, c.conv)).toMatchObject({ stopped: "waiting" });
    expect(r.calls.map((x) => x.event.type)).toEqual(["typing", "message.created"]);
    expect(r.calls[0]?.event).toMatchObject({ ephemeral: true, data: { state: "on" } });
    expect(r.calls[0]?.event.seq).toBeUndefined();
    const typing = (await rows(c)).filter((x) => x.seq === null);
    expect(typing).toMatchObject([{ attempt: 1, status: "failed", response_status: 500 }]);
  });

  test("one older than 30 s is dropped without being sent", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 0, true);
    // The event's created_at is the database's own time; age it past the limit.
    await su("update outbox_events set created_at = $2 where conversation_id = $1", [
      c.conv,
      new Date(clock.now() - 31_000),
    ]);
    const r = receiver();
    const { d } = deps(clock, r.sender);
    await deliverConversation(d, c.conv);
    expect(r.calls).toEqual([]);
    expect(await rows(c)).toMatchObject([{ attempt: 1, status: "dead", code: "webhook_stale" }]);
  });
});

describe("replays (ADR-029 §3)", () => {
  test("go out of band once, with the original seq and id, and a failed one is not retried", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 2);
    // Event 1 died earlier; event 2 is the stream's head and its receiver is down.
    await su(
      `update webhook_deliveries set status = 'dead', attempted_at = $2, error = '{"code":"webhook_rejected"}'::jsonb
        where conversation_id = $1 and seq = 1`,
      [c.conv, clock.date()],
    );
    const [first] = (await su("select id from outbox_events where conversation_id = $1 and seq = 1", [c.conv])) as {
      id: string;
    }[];
    await db.withWorkspace(c.ws, (tx) =>
      replayDelivery(tx, { connectionId: c.conn, outboxEventId: first?.id as string, at: clock.date() }),
    );
    const r = receiver(() => ({ kind: "response", status: 500 }));
    const { d } = deps(clock, r.sender);

    expect(await deliverConversation(d, c.conv)).toEqual({ sent: 2, stopped: "waiting" });
    // The replay went first, outside the stream, with its original seq; then the head.
    expect(r.calls.map((x) => [seqOf(x), attemptOf(x)])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    const replayed = (await su(
      "select attempt, status, replay from webhook_deliveries where conversation_id = $1 and seq = 1 order by attempt",
      [c.conv],
    )) as unknown[];
    expect(replayed).toEqual([
      { attempt: 1, status: "dead", replay: false },
      { attempt: 2, status: "failed", replay: true },
    ]);
  });
});

describe("failures that are not the receiver's answer", () => {
  test.each([
    ["a redirect", { kind: "response", status: 302 } as SendResult, "webhook_redirected"],
    [
      "egress refusing the address",
      { kind: "refused", code: "fetch_blocked", detail: "private" } as SendResult,
      "fetch_blocked",
    ],
  ])("%s is a failed attempt with its code", async (_label, answer, code) => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 1);
    const r = receiver(() => answer);
    const { d } = deps(clock, r.sender);
    await deliverConversation(d, c.conv);
    expect((await rows(c))[0]).toMatchObject({ attempt: 1, status: "failed", code });
  });

  test("a connection with no signing secret sends nothing and records webhook_secret_missing", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation({ secrets: [] });
    await events(c, clock, 1);
    const r = receiver();
    const { d } = deps(clock, r.sender);
    await deliverConversation(d, c.conv);
    expect(r.calls).toEqual([]);
    expect((await rows(c))[0]).toMatchObject({ attempt: 1, status: "failed", code: "webhook_secret_missing" });
  });
});

describe("connection status", () => {
  test("a paused connection holds its stream; nothing is attempted", async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 1);
    await su("update bridge_connections set status = 'paused' where id = $1", [c.conn]);
    const r = receiver();
    const { d } = deps(clock, r.sender);
    expect(await deliverConversation(d, c.conv)).toEqual({ sent: 0, stopped: "paused" });
    expect(r.calls).toEqual([]);
    expect((await rows(c))[0]).toMatchObject({ attempt: 1, status: "pending" });
  });

  test(`the ${DEAD_EVENTS_TO_DISABLE}th consecutive dead event disables the connection and writes an audit entry`, async () => {
    const clock = new FakeClock("2026-11-14T10:00:00.000Z");
    const c = await conversation();
    await events(c, clock, 2);
    await su("update bridge_connections set consecutive_dead = $2 where id = $1", [c.conn, DEAD_EVENTS_TO_DISABLE - 1]);
    const r = receiver(() => ({ kind: "response", status: 410 }));
    const { d, wakes } = deps(clock, r.sender);

    expect(await untilDrained(d, clock, wakes, c.conv)).toMatchObject({ stopped: "paused" });
    expect(await connection(c)).toEqual({ status: "disabled", consecutive_dead: DEAD_EVENTS_TO_DISABLE });
    // Event 2 is held, not attempted.
    expect(r.calls.every((x) => seqOf(x) === 1)).toBe(true);
    const audit = (await su(
      "select actor_type, action, target_type, target_id, meta from audit_log where workspace_id = $1 and action = 'connection.disabled'",
      [c.ws],
    )) as unknown[];
    expect(audit).toEqual([
      {
        actor_type: "system",
        action: "connection.disabled",
        target_type: "connection",
        target_id: c.conn,
        meta: { consecutiveDead: DEAD_EVENTS_TO_DISABLE },
      },
    ]);
  });
});

describe("the janitor", () => {
  test("wakes streams with a due delivery whose job was lost", async () => {
    const clock = new FakeClock(new Date());
    const c = await conversation();
    await events(c, clock, 1);
    const woken: string[] = [];
    await runJanitor({
      db,
      logger,
      enqueueTurn: async () => undefined,
      enqueueWebhook: async (id) => {
        woken.push(id);
      },
      batch: 10_000,
    });
    expect(woken).toContain(c.conv);
  });
});
