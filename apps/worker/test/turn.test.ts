import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { emptyState, newElementId, newId } from "@wakeel/contracts";
import {
  acquireConversationLease,
  appendInboundEvent,
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  listDraftDocs,
  saveDraftDoc,
  sql,
} from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import type { CodeOutcome, CodePort, CodeRequest, SandboxPort } from "@wakeel/engine";
import { createLogger } from "@wakeel/telemetry";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  botMessageId,
  drainConversation,
  runJanitor,
  type TurnDeps,
  turnEnqueuer,
  turnProcessor,
} from "../src/turn/index";
import { startWorkers } from "../src/workers";

/**
 * Task 4.4: the turn worker against real Postgres and Redis. Acceptance (build plan): a worker killed
 * mid-turn is resumed by another at the uncommitted step with no duplicate message; two messages sent
 * 5 ms apart are processed in order; a lost Redis job is recovered by the janitor.
 */
const REDIS_IMAGE = "redis:7.2.17-alpine@sha256:2f66de68111e64c3927859f158f8e666066dae2b97d9f82770a6f37a5aa1c335";

let database: StartedTestDatabase;
let db: Database;
let redis: StartedRedisContainer;

const logger = createLogger({
  service: "worker",
  level: "silent",
  destination: new Writable({ write: (_c, _e, d) => d() }),
});

beforeAll(async () => {
  [database, redis] = await Promise.all([startTestDatabase(), new RedisContainer(REDIS_IMAGE).start()]);
  db = createDatabase({ url: database.urls.rw, maxConnections: 8 });
});

afterAll(async () => {
  await db?.close();
  await Promise.all([database?.stop(), redis?.stop()]);
});

/** Expressions in these bots are property paths, which never reach the sandbox. */
const noSandbox: SandboxPort = {
  evalExpressions: async () => {
    throw new Error("these bots use paths only");
  },
};

const ok = (said: unknown[] = []): CodeOutcome => ({ ok: true, value: null, patches: {}, said, logs: [] });

function deps(overrides: Partial<TurnDeps> & { code?: CodePort } = {}) {
  const published: { channel: string; message: string }[] = [];
  const { code, ...rest } = overrides;
  const d: TurnDeps = {
    db,
    owner: `test-${randomBytes(3).toString("hex")}`,
    logger,
    enginePorts: () => ({ sandbox: noSandbox, code: code ?? { run: async () => ok() } }),
    publish: async (channel, message) => {
      published.push({ channel, message });
    },
    sleep: async () => {},
    heartbeatMs: 0,
    ...rest,
  };
  return { d, published };
}

const card = (extra: Record<string, unknown>) => ({ id: newElementId("card"), ...extra });

/** A workspace with a bot whose Main is Start → one node with `cards`, and one idle conversation. */
async function seed(cards: unknown[], settings: Record<string, unknown> = {}) {
  const userId = newId("usr");
  await su("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Turns",
    slug: `w-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "النور", slug: "noor", createdBy: userId }));
  await db.withWorkspace(ws, async (tx) => {
    const docs = await listDraftDocs(tx, bot.id);
    const manifest = docs.find((d) => d.kind === "manifest");
    const main = docs.find((d) => d.kind === "workflow");
    if (!manifest || !main) throw new Error("seeded bot is missing documents");
    const start = newElementId("node");
    const node = newElementId("node");
    await saveDraftDoc(tx, {
      botId: bot.id,
      kind: "workflow",
      docId: main.docId,
      expectedRev: main.rev,
      userId,
      doc: {
        id: main.docId,
        name: "Main",
        kind: "main",
        nodes: [
          { id: start, type: "start", name: "Start" },
          { id: node, type: "standard", name: "Reply", cards },
        ],
        edges: [{ id: newElementId("edge"), from: { nodeId: start, port: "next" }, to: { nodeId: node } }],
      },
    });
    const m = manifest.doc as { settings: Record<string, unknown> };
    await saveDraftDoc(tx, {
      botId: bot.id,
      kind: "manifest",
      docId: "manifest",
      expectedRev: manifest.rev,
      userId,
      doc: { ...m, settings: { ...m.settings, ...settings } },
    });
  });
  const ids = { ws, botId: bot.id, connectionId: newId("conn"), endUserId: newId("eu"), conversationId: newId("conv") };
  await db.withWorkspace(ws, async (tx) => {
    await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
      values (${ids.connectionId}, ${ws}, ${ids.botId}, 'Emulator', 'draft')`);
    await tx.execute(sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id)
      values (${ids.endUserId}, ${ws}, ${ids.botId}, ${ids.connectionId}, 'user-1')`);
    await tx.execute(sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes)
      values (${ids.conversationId}, ${ws}, ${ids.botId}, ${ids.connectionId}, ${ids.endUserId}, 'chat-1', 'emulator', 'idle', ${JSON.stringify(emptyState())}::jsonb, 60)`);
  });
  return ids;
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** What the Bridge API (4.5) does for a user message: the inbox row and the transcript row. */
async function send(c: Seeded, text: string) {
  return db.withWorkspace(c.ws, async (tx) => {
    const message = { type: "text", text, format: "plain" };
    const e = await appendInboundEvent(tx, { conversationId: c.conversationId, kind: "message", payload: { message } });
    await tx.execute(sql`insert into messages (id, workspace_id, conversation_id, direction, type, payload)
      values (${newId("msg")}, ${c.ws}, ${c.conversationId}, 'in', 'text', ${JSON.stringify(message)}::jsonb)`);
    return e;
  });
}

/** Reads and test-only changes as the superuser, outside any workspace. */
const su = (q: string, params: unknown[]) => superuserQuery(database.urls, q, params);
const query = async <T>(q: string, params: unknown[]) => (await su(q, params)) as T[];
const botTexts = async (c: Seeded) =>
  (
    await query<{ text: string }>(
      "select payload->>'text' as text from messages where conversation_id = $1 and direction = 'out' order by seq",
      [c.conversationId],
    )
  ).map((r) => r.text);
const outboxTypes = async (c: Seeded) =>
  (
    await query<{ type: string; seq: string | null }>(
      "select type, seq from outbox_events where conversation_id = $1 and not ephemeral order by seq",
      [c.conversationId],
    )
  ).map((r) => r.type);

describe("one message", () => {
  test("runs the bot, commits each step with deterministic message ids, and signals turn-done", async () => {
    const c = await seed([
      card({ type: "say", message: { type: "text", text: "أهلاً، كتبت: {{ event.text }}" } }),
      card({ type: "say", message: { type: "text", text: "إزاي أقدر أساعدك؟" } }),
    ]);
    await send(c, "عايز أعرف طلبي فين");
    const { d, published } = deps();
    expect(await drainConversation(d, c.conversationId)).toEqual({ turns: 1, stopped: "drained" });

    expect(await botTexts(c)).toEqual(["أهلاً، كتبت: عايز أعرف طلبي فين", "إزاي أقدر أساعدك؟"]);
    const [turn] = await query<{ id: string; status: string; step_count: number }>(
      "select id, status, step_count from turns where conversation_id = $1",
      [c.conversationId],
    );
    expect(turn).toMatchObject({ status: "completed", step_count: 2 });
    const ids = await query<{ id: string }>(
      "select id from messages where conversation_id = $1 and direction = 'out' order by seq",
      [c.conversationId],
    );
    expect(ids.map((r) => r.id)).toEqual([
      botMessageId(turn?.id as string, 1, 0),
      botMessageId(turn?.id as string, 2, 0),
    ]);
    expect(await outboxTypes(c)).toEqual(["message.created", "message.created", "turn.completed"]);
    const typing = await query<{ state: string }>(
      "select payload->'data'->>'state' as state from outbox_events where conversation_id = $1 and ephemeral order by created_at",
      [c.conversationId],
    );
    expect(typing.map((t) => t.state)).toEqual(["on", "off"]);
    const [conv] = await query<{ status: string; lease_until: Date | null; processed: number }>(
      `select status, lease_until, (select count(*)::int from inbound_events where conversation_id = $1 and processed_at is not null) as processed
       from conversations where id = $1`,
      [c.conversationId],
    );
    expect(conv).toMatchObject({ status: "idle", lease_until: null, processed: 1 });
    // SSE readers are told after each commit (typing on, two steps, typing off, the end of the turn).
    expect(
      published.filter((p) => p.channel === `conversation-events:${c.conversationId}`).length,
    ).toBeGreaterThanOrEqual(3);
    expect(published.filter((p) => p.channel.startsWith("turn-done:"))).toEqual([
      {
        channel: `turn-done:${c.conversationId}:1`,
        message: JSON.stringify({ turnId: turn?.id, status: "completed" }),
      },
    ]);
  });

  test("a conversation leased by another worker is left to it", async () => {
    const c = await seed([card({ type: "log", message: "x" })]);
    await send(c, "مرحبا");
    await db.withWorkspace(c.ws, (tx) => acquireConversationLease(tx, c.conversationId, "someone-else", 30_000));
    expect(await drainConversation(deps().d, c.conversationId)).toEqual({ turns: 0, stopped: "leased_elsewhere" });
  });

  test("an unknown conversation is reported, not retried", async () => {
    expect(await drainConversation(deps().d, newId("conv"))).toEqual({ turns: 0, stopped: "not_found" });
  });
});

describe("ordering", () => {
  test("two messages sent 5 ms apart are processed in order, one turn each, by one worker at a time", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "رد: {{ event.text }}" } })]);
    await send(c, "الأول");
    await send(c, "الثاني");
    // Two workers race for the same conversation; the lease lets one drain it.
    const results = await Promise.all([
      drainConversation(deps().d, c.conversationId),
      drainConversation(deps().d, c.conversationId),
    ]);
    expect(results.map((r) => r.turns).sort()).toEqual([0, 2]);
    expect(await botTexts(c)).toEqual(["رد: الأول", "رد: الثاني"]);
    const turns = await query<{ seq: string }>(
      "select e.seq from turns t join inbound_events e on e.id = t.trigger_event_id where t.conversation_id = $1 order by t.started_at",
      [c.conversationId],
    );
    expect(turns.map((t) => Number(t.seq))).toEqual([1, 2]);
  });
});

describe("a worker killed mid-turn", () => {
  test("another resumes at the uncommitted step and no message is written twice", async () => {
    const c = await seed([card({ type: "code", source: "A" }), card({ type: "code", source: "B" })]);
    await send(c, "ابدأ");

    // Worker A runs step 1, then hangs inside step 2 and stops renewing its lease, like a dead process.
    let releaseA: (o: CodeOutcome) => void = () => {};
    let reachedB: () => void = () => {};
    const atB = new Promise<void>((resolve) => {
      reachedB = resolve;
    });
    const aRuns: string[] = [];
    const a = deps({
      code: {
        run: (r: CodeRequest) => {
          aRuns.push(r.source);
          if (r.source === "A") return Promise.resolve(ok(["١"]));
          reachedB();
          return new Promise<CodeOutcome>((resolve) => {
            releaseA = resolve;
          });
        },
      },
    });
    const drainA = drainConversation(a.d, c.conversationId);
    await atB;
    expect(await botTexts(c)).toEqual(["١"]);

    // The lease lapses (the janitor's view: no live lease, events unprocessed); worker B takes over.
    await su("update conversations set lease_until = now() - interval '1 second' where id = $1", [c.conversationId]);
    expect((await db.lookup.conversationsToWake(1000)).map((r) => r.conversationId)).toContain(c.conversationId);
    const bRuns: string[] = [];
    const b = deps({
      code: {
        run: async (r: CodeRequest) => {
          bRuns.push(r.source);
          return ok(r.source === "A" ? ["١"] : ["٢"]);
        },
      },
    });
    expect(await drainConversation(b.d, c.conversationId)).toEqual({ turns: 1, stopped: "drained" });
    // B resumed at step 2: step 1 was committed, so it did not run again.
    expect(bRuns).toEqual(["B"]);

    // Worker A wakes up; its commit is fenced out.
    releaseA(ok(["٢ من العامل القديم"]));
    expect(await drainA).toEqual({ turns: 0, stopped: "lease_lost" });
    expect(aRuns).toEqual(["A", "B"]);

    expect(await botTexts(c)).toEqual(["١", "٢"]);
    expect(await outboxTypes(c)).toEqual(["message.created", "message.created", "turn.completed"]);
    const [turn] = await query<{ status: string; step_count: number; n: number }>(
      "select status, step_count, (select count(*)::int from turns where conversation_id = $1) as n from turns where conversation_id = $1",
      [c.conversationId],
    );
    expect(turn).toMatchObject({ status: "completed", step_count: 2, n: 1 });
  });
});

describe("the janitor", () => {
  test("recovers a lost Redis job: the conversation is processed by the worker it wakes", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "وصلت" } })]);
    // The message is in the inbox, but its `turn` job never reached Redis.
    await send(c, "مرحبا");
    const connection = { url: redis.getConnectionUrl(), maxRetriesPerRequest: null };
    const queue = new Queue("turn", { connection });
    let resolveDone: (channel: string) => void = () => {};
    const done = new Promise<string>((resolve) => {
      resolveDone = resolve;
    });
    const { d } = deps({
      publish: async (channel) => {
        if (channel.startsWith("turn-done:")) resolveDone(channel);
      },
    });
    const running = startWorkers({
      redisUrl: redis.getConnectionUrl(),
      queues: ["turn"],
      processors: { turn: turnProcessor(d) },
      logger,
    });
    await running.ready();
    try {
      const result = await runJanitor({ db, logger, enqueueTurn: turnEnqueuer(queue) });
      expect(result.woken).toBeGreaterThanOrEqual(1);
      expect(await done).toBe(`turn-done:${c.conversationId}:1`);
      expect(await botTexts(c)).toEqual(["وصلت"]);
    } finally {
      await running.close();
      await queue.close();
    }
  });

  test("times out a waiting conversation past its deadline, which then ends with reason inactivity", async () => {
    const into = newElementId("var");
    const c = await seed([card({ type: "capture", prompt: { type: "text", text: "رقم الطلب؟" }, kind: "text", into })]);
    await su(
      "update bot_draft_docs set doc = jsonb_set(doc, '{variables}', $2::jsonb) where bot_id = $1 and kind = 'manifest'",
      [c.botId, JSON.stringify([{ id: into, name: "order", scope: "conversation", type: "string" }])],
    );
    await send(c, "مرحبا");
    await drainConversation(deps().d, c.conversationId);
    const [waiting] = await query<{ status: string; minutes: number }>(
      "select status, extract(epoch from expires_at - last_activity_at)::int / 60 as minutes from conversations where id = $1",
      [c.conversationId],
    );
    expect(waiting).toEqual({ status: "waiting_input", minutes: 1_440 });

    await su("update conversations set expires_at = now() - interval '1 second' where id = $1", [c.conversationId]);
    const enqueued: string[] = [];
    const run = await runJanitor({ db, logger, enqueueTurn: async (id) => void enqueued.push(id) });
    expect(run.timedOut).toBeGreaterThanOrEqual(1);
    expect(enqueued).toContain(c.conversationId);
    // A second run does not add a second timeout while the first is pending.
    await runJanitor({ db, logger, enqueueTurn: async () => {} });
    expect(
      await query("select 1 from inbound_events where conversation_id = $1 and kind = 'timeout'", [c.conversationId]),
    ).toHaveLength(1);

    await drainConversation(deps().d, c.conversationId);
    const [ended] = await query<{ status: string; ended_reason: string }>(
      "select status, ended_reason from conversations where id = $1",
      [c.conversationId],
    );
    expect(ended).toEqual({ status: "ended", ended_reason: "inactivity" });
    expect(await outboxTypes(c)).toContain("conversation.ended");
  });
});

describe("coalescing", () => {
  test("text messages arriving within the window become one turn", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "{{ event.text }}" } })], {
      coalesceWindowMs: 800,
    });
    await send(c, "أهلاً");
    let waited = 0;
    const { d, published } = deps({
      sleep: async (ms) => {
        waited = ms;
        // The user keeps typing during the window.
        await send(c, "عايز أعرف طلبي فين");
      },
    });
    expect(await drainConversation(d, c.conversationId)).toEqual({ turns: 1, stopped: "drained" });
    expect(waited).toBe(800);
    expect(await botTexts(c)).toEqual(["أهلاً\nعايز أعرف طلبي فين"]);
    expect(published.map((p) => p.channel).filter((ch) => ch.startsWith("turn-done:"))).toEqual([
      `turn-done:${c.conversationId}:1`,
      `turn-done:${c.conversationId}:2`,
    ]);
    const events = await query<{ turn_id: string; processed: boolean }>(
      "select turn_id, processed_at is not null as processed from inbound_events where conversation_id = $1",
      [c.conversationId],
    );
    expect(new Set(events.map((e) => e.turn_id)).size).toBe(1);
    expect(events.every((e) => e.processed)).toBe(true);
  });
});

describe("message ids", () => {
  test("are ADR-012 message ids, stable for the same step and distinct otherwise", () => {
    const turn = newId("turn");
    const id = botMessageId(turn, 3, 0);
    expect(id).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(botMessageId(turn, 3, 0)).toBe(id);
    expect(
      new Set([id, botMessageId(turn, 3, 1), botMessageId(turn, 4, 0), botMessageId(newId("turn"), 3, 0)]).size,
    ).toBe(4);
  });
});
