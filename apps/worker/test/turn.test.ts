import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { emptyState, newElementId, newId, Workflow } from "@wakeel/contracts";
import {
  acquireConversationLease,
  appendInboundEvent,
  createBot,
  createDatabase,
  createKnowledgeBase,
  createSource,
  createTable,
  createWorkflowDoc,
  createWorkspace,
  type Database,
  getDraftDoc,
  type Keyring,
  listDraftDocs,
  memoryObjectStore,
  publishDraft,
  putConfigValue,
  replaceChunks,
  saveDraftDoc,
  sql,
  startTurn,
  tracePayloadKey,
  updateDocument,
  updateWorkspace,
  upsertDocument,
} from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import type { CodeOutcome, CodePort, CodeRequest, KnowledgePort, SandboxPort } from "@wakeel/engine";
import type { LlmClient } from "@wakeel/llm";
import { createLogger } from "@wakeel/telemetry";
import { FakeLlm } from "@wakeel/testing";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { turnKnowledge } from "../src/kb/search";
import {
  aiPort,
  autonomyPort,
  botMessageId,
  drainConversation,
  modelHandoffSummary,
  resolveModel,
  runJanitor,
  SUMMARY_SYSTEM,
  type TurnDeps,
  turnEnqueuer,
  turnFollowUp,
  turnProcessor,
} from "../src/turn/index";
import { turnTables } from "../src/turn/tables";
import { maintainTraces } from "../src/turn/trace-retention";
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

/**
 * A workspace with a bot whose Main is Start → one node with `cards` (plus any `extra` nodes and
 * edges), and one new, idle conversation.
 */
async function seed(
  cards: unknown[],
  settings: Record<string, unknown> = {},
  extra: { nodes?: unknown[]; edges?: unknown[]; mainNode?: Record<string, unknown>; workflows?: unknown[] } = {},
) {
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
          { id: node, ...(extra.mainNode ?? { type: "standard", name: "Reply", cards }) },
          ...(extra.nodes ?? []),
        ],
        edges: [
          { id: newElementId("edge"), from: { nodeId: start, port: "next" }, to: { nodeId: node } },
          ...(extra.edges ?? []),
        ],
      },
    });
    for (const doc of extra.workflows ?? []) await createWorkflowDoc(tx, { botId: bot.id, doc, userId });
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
  const ids = {
    userId,
    ws,
    botId: bot.id,
    connectionId: newId("conn"),
    endUserId: newId("eu"),
    conversationId: newId("conv"),
  };
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

/** The trace of a conversation's turns as stored (task 4.7). */
const spansOf = (c: Seeded) =>
  query<{
    seq: number;
    kind: string;
    name: string;
    parent_seq: number | null;
    status: string;
    attrs: Record<string, unknown>;
  }>(
    `select s.seq, s.kind, s.name, p.seq as parent_seq, s.status, s.attrs
       from trace_spans s left join trace_spans p on p.id = s.parent_id
      where s.conversation_id = $1 order by s.turn_id, s.seq`,
    [c.conversationId],
  );

describe("traces (task 4.7)", () => {
  test("a turn writes complete, ordered spans: the turn, each node, each card, code under code cards", async () => {
    const c = await seed([
      card({ type: "say", message: { type: "text", text: "أهلاً" } }),
      card({ type: "code", source: "log.info('hi')" }),
    ]);
    await send(c, "مرحبا");
    const { d } = deps();
    await drainConversation(d, c.conversationId);
    const spans = await spansOf(c);
    expect(spans.map((s) => [s.seq, s.kind, s.name, s.parent_seq])).toEqual([
      // Start has no cards and runs no step of its own, so the first node span is Reply.
      [0, "turn", "Turn", null],
      [1, "node", "Reply", 0],
      [2, "card", "say", 1],
      [3, "card", "code", 1],
      [4, "code.exec", "Run code", 3],
    ]);
    expect(spans[0]?.attrs).toMatchObject({ trigger: "message", mode: "emulator", outcome: "completed", stepCount: 2 });
    expect(spans[1]?.attrs).toMatchObject({ nodeType: "standard", leftBy: "next" });
  });

  test("a failing trace store never fails the turn", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "أهلاً" } })]);
    await send(c, "مرحبا");
    const { d } = deps({
      writeSpans: async () => {
        throw new Error("trace store is down");
      },
    });
    expect(await drainConversation(d, c.conversationId)).toEqual({ turns: 1, stopped: "drained" });
    expect(await botTexts(c)).toEqual(["أهلاً"]);
    expect(await spansOf(c)).toEqual([]);
  });
});

describe("the conversation_started trigger (task 4.8, ADR-027)", () => {
  test("runs before Start on a new conversation's first message, and not on the next", async () => {
    const trigger = newElementId("node");
    const welcome = newElementId("node");
    const c = await seed(
      [card({ type: "say", message: { type: "text", text: "إزاي أقدر أساعدك؟" } })],
      {},
      {
        nodes: [
          { id: trigger, type: "trigger", name: "Started", on: { kind: "conversation_started" } },
          {
            id: welcome,
            type: "standard",
            name: "Welcome",
            cards: [card({ type: "say", message: { type: "text", text: "أهلاً بيك في النور" } })],
          },
        ],
        edges: [{ id: newElementId("edge"), from: { nodeId: trigger, port: "next" }, to: { nodeId: welcome } }],
      },
    );
    const { d } = deps();
    await send(c, "السلام عليكم");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["أهلاً بيك في النور", "إزاي أقدر أساعدك؟"]);
    const [conv] = await query<{ state: { started?: boolean } }>("select state from conversations where id = $1", [
      c.conversationId,
    ]);
    expect(conv?.state.started).toBe(true);

    await send(c, "عندي سؤال");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["أهلاً بيك في النور", "إزاي أقدر أساعدك؟", "إزاي أقدر أساعدك؟"]);
    // The trigger's path comes first in the trace. Trigger and Start pass straight through (no step,
    // so no span of their own, as in 4.7).
    const nodes = (await spansOf(c)).filter((s) => s.kind === "node").map((s) => s.name);
    expect(nodes).toEqual(["Welcome", "Reply", "Reply"]);
  });
});

describe("handoff (task 5.4)", () => {
  test("hands off with a model summary, stays silent while handed off, and resumes when released", async () => {
    const c = await seed([
      card({ type: "say", message: { type: "text", text: "أهلاً" } }),
      card({ type: "handoff", reason: "طلب موظف", message: { type: "text", text: "هحولك لزميل" } }),
    ]);
    const llm = new FakeLlm().scriptText("العميل بيسأل عن طلب متأخر وعايز يكلم موظف");
    // The bot's utility model, as its registry id, with the conversation's context for the usage record.
    const summarizeHandoff = modelHandoffSummary({ db, model: llm });
    const { d } = deps({ summarizeHandoff });

    await send(c, "عايز أكلم حد من خدمة العملاء، طلبي اتأخر");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["أهلاً", "هحولك لزميل"]);
    const [handedOff] = await query<{ status: string; handoff: Record<string, unknown> }>(
      "select status, handoff from conversations where id = $1",
      [c.conversationId],
    );
    expect(handedOff).toEqual({
      status: "handed_off",
      handoff: { reason: "طلب موظف", summary: "العميل بيسأل عن طلب متأخر وعايز يكلم موظف", variables: {} },
    });
    // The customer's words reach the model as messages; the system text is fixed (CLAUDE.md §9).
    const request = llm.calls[0]?.request as {
      model: string;
      system: string;
      messages: { role: string; content: string }[];
      context: { mode: string; workspaceId: string };
    };
    expect(request.model).not.toContain(":");
    expect(request.context).toMatchObject({ mode: "emulator", workspaceId: c.ws });
    expect(request.system).toBe(SUMMARY_SYSTEM);
    expect(request.messages).toEqual([
      { role: "user", content: "عايز أكلم حد من خدمة العملاء، طلبي اتأخر" },
      { role: "assistant", content: "أهلاً" },
      // The card's own message is part of the same step, committed after the summary is written.
      { role: "user", content: "Reason for the handoff: طلب موظف" },
    ]);
    expect(await outboxTypes(c)).toContain("handoff.requested");

    // While handed off, messages are stored and get no reply.
    await send(c, "فين الموظف؟");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["أهلاً", "هحولك لزميل"]);
    const inbound = await query<{ n: number }>(
      "select count(*)::int as n from messages where conversation_id = $1 and direction = 'in'",
      [c.conversationId],
    );
    expect(inbound[0]?.n).toBe(2);

    // Released: idle again, the handoff cleared, and the next message runs the bot from Start.
    await db.withWorkspace(c.ws, (tx) =>
      appendInboundEvent(tx, { conversationId: c.conversationId, kind: "handoff_release", payload: {} }),
    );
    await drainConversation(d, c.conversationId);
    const [released] = await query<{ status: string; handoff: unknown }>(
      "select status, handoff from conversations where id = $1",
      [c.conversationId],
    );
    expect(released).toEqual({ status: "idle", handoff: null });
    llm.scriptText("ملخص تاني");
    await send(c, "شكراً");
    await drainConversation(d, c.conversationId);
    expect((await botTexts(c)).slice(2)).toEqual(["أهلاً", "هحولك لزميل"]);
  });
});

describe("webhooks (task 5.2)", () => {
  test("a turn on a connection with a webhook creates deliveries and wakes the webhook queue once they commit", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "أهلاً" } })]);
    await su(
      "update bridge_connections set webhook_url = 'https://receiver.example.test/hook', subscribed_events = array['message.created', 'turn.completed'] where id = $1",
      [c.connectionId],
    );
    // The emulator's conversations are emulator mode; this one is a live bridge conversation.
    await su("update conversations set mode = 'live' where id = $1", [c.conversationId]);
    await send(c, "مرحبا");
    const woken: { conversationId: string; deliveries: number }[] = [];
    const { d } = deps({
      enqueueWebhook: async (conversationId) => {
        const [row] = await query<{ n: number }>(
          "select count(*)::int as n from webhook_deliveries where conversation_id = $1",
          [conversationId],
        );
        woken.push({ conversationId, deliveries: row?.n ?? 0 });
      },
    });
    await drainConversation(d, c.conversationId);
    // Every wake happens after a commit: the deliveries it announces are already visible.
    expect(woken.length).toBeGreaterThanOrEqual(1);
    for (const w of woken) expect(w).toMatchObject({ conversationId: c.conversationId });
    expect(woken.every((w) => w.deliveries > 0)).toBe(true);
    const rows = await query<{ type: string; seq: string; status: string }>(
      `select o.type, d.seq, d.status from webhook_deliveries d join outbox_events o on o.id = d.outbox_event_id
        where d.conversation_id = $1 order by d.seq`,
      [c.conversationId],
    );
    // Typing is not subscribed, so only the message and the turn's end are delivered.
    expect(rows.map((r) => r.type)).toEqual(["message.created", "turn.completed"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });
});

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

    // The trace continues where worker A left it: one span per step, none twice, the node closed once.
    const spans = await spansOf(c);
    expect(spans.map((s) => [s.seq, s.kind, s.name])).toEqual([
      [0, "turn", "Turn"],
      [1, "node", "Reply"],
      [2, "card", "code"],
      [3, "code.exec", "Run code"],
      [4, "card", "code"],
      [5, "code.exec", "Run code"],
    ]);
    expect(spans[0]?.attrs).toMatchObject({ outcome: "completed", stepCount: 2 });
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

  test("a message that arrives while the last turn's job is finishing is answered without the janitor", async () => {
    // The race behind slow second replies: the turn-done signal reaches the user before BullMQ
    // removes the finished job, so the next message's job (same id: the conversation) is dropped.
    const c = await seed([card({ type: "say", message: { type: "text", text: "تمام" } })]);
    await send(c, "أول");
    const connection = { url: redis.getConnectionUrl(), maxRetriesPerRequest: null };
    const queue = new Queue("turn", { connection });
    const enqueue = turnEnqueuer(queue);
    let resolveSecond: (channel: string) => void = () => {};
    const second = new Promise<string>((resolve) => {
      resolveSecond = resolve;
    });
    const { d } = deps({
      publish: async (channel) => {
        if (channel === `turn-done:${c.conversationId}:2`) resolveSecond(channel);
      },
    });
    const base = turnProcessor(d);
    let injected = false;
    const running = startWorkers({
      redisUrl: redis.getConnectionUrl(),
      queues: ["turn"],
      processors: {
        turn: async (job, log) => {
          const result = await base(job, log);
          if (!injected) {
            injected = true;
            // The job is still active here, so this enqueue is a no-op in BullMQ.
            await send(c, "تاني");
            await enqueue(c.conversationId);
          }
          return result;
        },
      },
      onCompleted: { turn: turnFollowUp({ db, logger, enqueueTurn: enqueue }) },
      logger,
    });
    await running.ready();
    try {
      await enqueue(c.conversationId);
      expect(await second).toBe(`turn-done:${c.conversationId}:2`);
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

describe("the Autonomous Node (task 6.6)", () => {
  const lookupOrder = {
    id: newElementId("tool"),
    type: "code",
    name: "lookupOrder",
    description: "Finds an order by its number.",
    input: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
    source: "return { status: 'shipped' };",
  };
  const agent = (extra: Record<string, unknown> = {}) => ({
    type: "autonomous",
    name: "Assistant",
    instructions: "You help customers of {{ bot.name }} track their orders.",
    model: "openai:gpt-4.1-mini",
    tools: [lookupOrder],
    ...extra,
  });

  test("replies through the model and waits for the user; the model is the node's own", async () => {
    const c = await seed([], {}, { mainNode: agent() });
    const llm = new FakeLlm().scriptText(":::say text\nأهلاً، ابعتلي رقم الطلب\n:::exit listen\n:::end");
    const { d } = deps({
      autonomy: (turn, code) =>
        autonomyPort(
          { db, llm: llm as never, runPort: { run: async () => Promise.reject(new Error("no run")) }, logger },
          turn,
          code,
        ),
    });
    await send(c, "طلبي اتأخر");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["أهلاً، ابعتلي رقم الطلب"]);
    const [conv] = await query<{ status: string }>("select status from conversations where id = $1", [
      c.conversationId,
    ]);
    expect(conv?.status).toBe("waiting_input");
    const request = llm.calls[0]?.request as {
      model: string;
      system: string;
      messages: { role: string; content: string }[];
      context: { mode: string };
    };
    expect(request.model).toBe("gpt-4.1-mini");
    expect(request.context.mode).toBe("emulator");
    // The customer's words are a message, never system text (CLAUDE.md §9).
    expect(request.system).not.toContain("طلبي اتأخر");
    expect(request.messages.map((m) => m.content).join("\n")).toContain("طلبي اتأخر");
    expect(request.system).toContain("lookupOrder");
    llm.expectDone();
  });

  test("a run block calls a code tool; its result is the next iteration's feedback", async () => {
    const c = await seed([], {}, { mainNode: agent() });
    const llm = new FakeLlm()
      .scriptText(':::run\nreturn await tools.lookupOrder({ number: "5678" })\n:::end')
      .scriptText(":::say text\nطلبك اتشحن\n:::exit listen\n:::end");
    const codeRuns: CodeRequest[] = [];
    const code: CodePort = {
      run: async (r) => {
        codeRuns.push(r);
        return { ok: true, value: { status: "shipped" }, patches: {}, said: [], logs: [] };
      },
    };
    const { d } = deps({
      code,
      autonomy: (turn, port) =>
        autonomyPort(
          {
            db,
            llm: llm as never,
            runPort: {
              // Stands in for the sandbox: the model's code makes exactly this one call.
              run: async (r) => {
                const value = await r.onTool({ tool: "lookupOrder", input: { number: "5678" } });
                return { ok: true, value, patches: { memo: { set: { looked: true } } }, logs: [] };
              },
            },
            logger,
          },
          turn,
          port,
        ),
    });
    await send(c, "رقم الطلب 5678");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["طلبك اتشحن"]);
    expect(codeRuns).toHaveLength(1);
    expect(codeRuns[0]?.source.startsWith('const input = {"number":"5678"}; ')).toBe(true);
    const second = llm.calls[1]?.request as { messages: { content: string }[] };
    expect(second.messages.at(-1)?.content).toContain('{"status":"shipped"}');
    expect(second.messages.at(-1)?.content).toContain('"looked"');
    llm.expectDone();

    // The trace (task 6.9): two iterations, each with its model call; the tool call under the first.
    const spans = await spansOf(c);
    const kinds = spans.filter((s) => s.kind !== "turn").map((s) => s.kind);
    expect(kinds).toEqual(["node", "autonomy.iteration", "llm.call", "tool.call", "autonomy.iteration", "llm.call"]);
    const tool = spans.find((s) => s.kind === "tool.call");
    expect(tool?.attrs).toMatchObject({
      name: "lookupOrder",
      toolType: "code",
      input: { inline: true, value: { number: "5678" } },
      output: { inline: true, value: { status: "shipped" } },
    });
    const iterations = spans.filter((s) => s.kind === "autonomy.iteration");
    expect(iterations.map((s) => s.attrs["status"])).toEqual(["run_result", "exit"]);
    expect(spans.find((s) => s.kind === "llm.call")?.attrs).toMatchObject({
      purpose: "autonomy",
      usage: { inputTokens: expect.any(Number) },
    });
  });
});

describe("model resolution (task 6.6, ADR-032 §5)", () => {
  const node = { model: undefined } as const;

  test("the model: the node's, then the bot's default, as a registry id", () => {
    const definition = { manifest: { settings: { models: { default: "anthropic:claude-sonnet-5-5" } } } } as never;
    expect(resolveModel({ ...node, model: "openai:gpt-4.1-mini" } as never, definition, undefined)).toBe(
      "gpt-4.1-mini",
    );
    expect(resolveModel(node as never, definition, "gpt-4.1")).toBe("claude-sonnet-5-5");
  });
});

describe("workflow tools (task 6.6, ADR-035)", () => {
  /**
   * Acceptance (build plan 6.6): a workflow tool that asks the user a question suspends the node; the
   * user's answer finishes the workflow, and the node resumes with "code after the call did not run".
   */
  test("a workflow that asks the user a question suspends the node, which resumes with its outputs", async () => {
    const sub = newElementId("wf");
    const address = newElementId("var");
    const entry = newElementId("node");
    const ask = newElementId("node");
    const exit = newElementId("node");
    const askAddress = {
      id: newElementId("tool"),
      type: "workflow",
      name: "askAddress",
      description: "Asks the customer for their delivery address.",
      workflowId: sub,
    };
    const c = await seed(
      [],
      {},
      {
        mainNode: {
          type: "autonomous",
          name: "Assistant",
          instructions: "You arrange deliveries.",
          model: "openai:gpt-4.1-mini",
          tools: [askAddress],
        },
        workflows: [
          {
            id: sub,
            name: "Ask address",
            kind: "sub",
            variables: [{ id: address, name: "address", scope: "workflow", type: "string" }],
            inputs: [{ name: "reason", type: "string", required: true }],
            outputs: [{ name: "address", type: "string", required: true }],
            nodes: [
              { id: entry, type: "entry", name: "Entry" },
              {
                id: ask,
                type: "standard",
                name: "Ask",
                cards: [
                  card({ type: "capture", prompt: { type: "text", text: "عنوانك إيه؟" }, kind: "text", into: address }),
                ],
              },
              { id: exit, type: "exit", name: "Done", outputs: { address: "workflow.address" } },
            ],
            edges: [
              { id: newElementId("edge"), from: { nodeId: entry, port: "next" }, to: { nodeId: ask } },
              { id: newElementId("edge"), from: { nodeId: ask, port: "next" }, to: { nodeId: exit } },
            ],
          },
        ],
      },
    );
    const llm = new FakeLlm()
      .scriptText(
        ':::say text\nهحتاج عنوانك\n:::run\nmemo.asked = true\nconst a = await tools.askAddress({ reason: "delivery" })\nreturn a\n:::end',
      )
      .scriptText(":::say text\nتمام، هنوصل على ١٢ شارع التحرير\n:::exit listen\n:::end");
    const afterCall: string[] = [];
    const { d } = deps({
      autonomy: (turn, port) =>
        autonomyPort(
          {
            db,
            llm: llm as never,
            runPort: {
              // Stands in for the sandbox: the code calls the tool, then would go on if it were answered.
              run: (r) =>
                new Promise((resolve, reject) => {
                  r.signal?.addEventListener("abort", () => reject(r.signal?.reason), { once: true });
                  r.onTool({ tool: "askAddress", input: { reason: "delivery" } }).then((value) => {
                    afterCall.push("ran");
                    resolve({ ok: true, value, patches: { memo: { set: { asked: true } } }, logs: [] });
                  }, reject);
                }),
            },
            logger,
          },
          turn,
          port,
        ),
    });

    await send(c, "عايز أغير عنوان التوصيل");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["هحتاج عنوانك", "عنوانك إيه؟"]);
    const [waiting] = await query<{ status: string; state: { autonomy: Record<string, { pendingTool?: unknown }> } }>(
      "select status, state from conversations where id = $1",
      [c.conversationId],
    );
    expect(waiting?.status).toBe("waiting_input");
    expect(Object.values(waiting?.state.autonomy ?? {})[0]?.pendingTool).toMatchObject({ name: "askAddress" });

    await send(c, "١٢ شارع التحرير");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["هحتاج عنوانك", "عنوانك إيه؟", "تمام، هنوصل على ١٢ شارع التحرير"]);
    expect(afterCall).toEqual([]);
    const resumed = llm.calls[1]?.request as { messages: { content: string }[] };
    const feedback = resumed.messages.at(-1)?.content ?? "";
    expect(feedback).toContain('Tool askAddress finished with {"address":"١٢ شارع التحرير"}.');
    expect(feedback).toContain("Code after that call did not run");
    // memo was set before the call; the block was stopped, so its changes were not kept (ADR-035 §2).
    expect(feedback).not.toContain('"asked"');
    const [done] = await query<{ status: string; state: { autonomy: Record<string, { pendingTool?: unknown }> } }>(
      "select status, state from conversations where id = $1",
      [c.conversationId],
    );
    expect(done?.status).toBe("waiting_input");
    expect(Object.values(done?.state.autonomy ?? {})[0]?.pendingTool).toBeUndefined();
    llm.expectDone();
  });

  test("a submitted tool result resumes a node waiting on it (submitToolResult, ADR-029 §2)", async () => {
    const tool = newElementId("tool");
    const c = await seed(
      [],
      {},
      {
        mainNode: {
          type: "autonomous",
          name: "Assistant",
          instructions: "You take payments.",
          model: "openai:gpt-4.1-mini",
          tools: [
            {
              id: tool,
              type: "code",
              name: "charge",
              description: "Charges the card.",
              input: { type: "object" },
              source: "return null",
            },
          ],
        },
      },
    );
    // The state a code tool's `ctx.suspend` leaves (deferred, ADR-035 §7): the node waits on the call.
    const [main] = await query<{ doc: { nodes: { id: string; type: string }[]; id: string } }>(
      "select doc from bot_draft_docs where bot_id = $1 and kind = 'workflow'",
      [c.botId],
    );
    const nodeId = main?.doc.nodes.find((n) => n.type === "autonomous")?.id as string;
    const wfId = main?.doc.id as string;
    const toolCallId = "turn_x:1:run:charge";
    const state = {
      ...emptyState(),
      status: "waiting_external",
      started: true,
      stack: [{ workflowId: wfId, nodeId, cardIndex: 0, vars: {}, inputs: {} }],
      wait: { kind: "tool", nodeId, toolId: tool, toolCallId, since: new Date().toISOString() },
      autonomy: {
        [`${wfId}:${nodeId}`]: {
          iteration: 2,
          memo: {},
          feedback: [],
          pendingTool: { toolId: tool, toolCallId, name: "charge", input: { amount: 10 } },
        },
      },
    };
    await su("update conversations set status = 'waiting_external', state = $2::jsonb where id = $1", [
      c.conversationId,
      JSON.stringify(state),
    ]);
    await db.withWorkspace(c.ws, (tx) =>
      appendInboundEvent(tx, {
        conversationId: c.conversationId,
        kind: "tool_result",
        payload: { toolCallId, result: { paid: true } },
      }),
    );
    const llm = new FakeLlm().scriptText(":::say text\nتم الدفع\n:::exit listen\n:::end");
    const { d } = deps({
      autonomy: (turn, port) =>
        autonomyPort(
          { db, llm: llm as never, runPort: { run: async () => Promise.reject(new Error("no run")) }, logger },
          turn,
          port,
        ),
    });
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["تم الدفع"]);
    const request = llm.calls[0]?.request as { messages: { content: string }[] };
    expect(request.messages.at(-1)?.content).toContain('Tool charge finished with {"paid":true}.');
    llm.expectDone();
  });
});

describe("AI cards (task 6.7)", () => {
  test("Generate text calls the bot's default model with the workspace context and sends the reply", async () => {
    const into = newElementId("var");
    const c = await seed([
      card({
        type: "ai_generate",
        instructions: "رد على العميل بجملة واحدة",
        input: "{{ event.text }}",
        into,
        send: true,
      }),
    ]);
    await su(
      "update bot_draft_docs set doc = jsonb_set(doc, '{variables}', $2::jsonb) where bot_id = $1 and kind = 'manifest'",
      [c.botId, JSON.stringify([{ id: into, name: "reply", scope: "conversation", type: "string" }])],
    );
    const llm = new FakeLlm().scriptText("أهلاً بيك، هنساعدك حالاً.");
    const { d } = deps({ ai: (turn) => aiPort({ llm: llm as never }, turn) });
    await send(c, "محتاج مساعدة");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["أهلاً بيك، هنساعدك حالاً."]);
    const request = llm.calls[0]?.request as {
      model: string;
      purpose: string;
      system: string;
      context: { mode: string; turnId: string };
    };
    expect(request.purpose).toBe("ai_generate");
    expect(request.model).not.toContain(":");
    expect(request.system).not.toContain("محتاج مساعدة");
    expect(request.context.mode).toBe("emulator");
    llm.expectDone();
  });
});

describe("published versions (task 7.2)", () => {
  const TOPIC = "var_topic00001";

  /** Replaces Main's one node with `node` (same id or a new one) and the manifest's variables. */
  async function edit(c: Seeded, node: Record<string, unknown>, variables: unknown[]) {
    await db.withWorkspace(c.ws, async (tx) => {
      const docs = await listDraftDocs(tx, c.botId);
      const main = docs.find((d) => d.kind === "workflow");
      if (!main) throw new Error("no main");
      const wf = main.doc as { nodes: { id: string; type: string }[]; edges: { to: { nodeId: string } }[] };
      const start = wf.nodes.find((n) => n.type === "start");
      await saveDraftDoc(tx, {
        botId: c.botId,
        kind: "workflow",
        docId: main.docId,
        expectedRev: main.rev,
        userId: null,
        doc: {
          ...wf,
          nodes: [start, node],
          edges: [{ id: newElementId("edge"), from: { nodeId: start?.id, port: "next" }, to: { nodeId: node["id"] } }],
        },
      });
      const m = await getDraftDoc(tx, c.botId, "manifest", "manifest");
      await saveDraftDoc(tx, {
        botId: c.botId,
        kind: "manifest",
        docId: "manifest",
        expectedRev: m.rev,
        userId: null,
        doc: { ...(m.doc as object), variables },
      });
    });
  }
  const publish = (c: Seeded, label: string) =>
    db.withWorkspace(c.ws, async (tx) => (await publishDraft(tx, { botId: c.botId, label, userId: null })).version.id);

  /** Makes the seeded conversation live on a production connection, pinned to `versionId`. */
  async function goLive(c: Seeded, versionId: string, state: Record<string, unknown>) {
    await su("update bridge_connections set target = 'production' where id = $1", [c.connectionId]);
    await su("update conversations set mode = 'live', version_id = $2, state = $3::jsonb, status = $4 where id = $1", [
      c.conversationId,
      versionId,
      JSON.stringify(state),
      state["status"],
    ]);
  }

  test("a stack position that still exists is kept; the turn runs the new version", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "النسخة الأولى" } })]);
    const v1 = await publish(c, "v1");
    const [node] = await query<{ id: string }>(
      "select n->>'id' as id from bot_versions, jsonb_array_elements(definition->'workflows'->0->'nodes') n where id = $1 and n->>'type' = 'standard'",
      [v1],
    );
    await edit(
      c,
      {
        id: node?.id,
        type: "standard",
        name: "Reply",
        cards: [card({ type: "say", message: { type: "text", text: "النسخة التانية" } })],
      },
      [],
    );
    const v2 = await publish(c, "v2");
    await goLive(c, v1, emptyState());
    await send(c, "أهلاً");
    expect(await drainConversation(deps().d, c.conversationId)).toEqual({ turns: 1, stopped: "drained" });
    expect(await botTexts(c)).toEqual(["النسخة التانية"]);
    const [conv] = await query<{ version_id: string }>("select version_id from conversations where id = $1", [
      c.conversationId,
    ]);
    expect(conv?.version_id).toBe(v2);
    const migrated = (await spansOf(c)).filter((s) => s.kind === "version.migrated");
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({
      parent_seq: 0,
      attrs: { fromVersionId: v1, toVersionId: v2, positionKept: true, dropped: [] },
    });
  });

  test("a stack position that is gone resets the stack, keeps variables that still fit, and lists the drops", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "أهلاً" } })]);
    await edit(
      c,
      {
        id: newElementId("node"),
        type: "standard",
        name: "Old",
        cards: [card({ type: "say", message: { type: "text", text: "قديم" } })],
      },
      [{ id: TOPIC, name: "topic", scope: "conversation", type: "string", sensitive: false }],
    );
    const v1 = await publish(c, "v1");
    const [old] = await query<{ id: string; wf: string }>(
      "select n->>'id' as id, definition->'workflows'->0->>'id' as wf from bot_versions, jsonb_array_elements(definition->'workflows'->0->'nodes') n where id = $1 and n->>'type' = 'standard'",
      [v1],
    );
    // v2 replaces the node and makes `topic` a number, so the stored text no longer fits.
    await edit(
      c,
      {
        id: newElementId("node"),
        type: "standard",
        name: "New",
        cards: [card({ type: "say", message: { type: "text", text: "جديد" } })],
      },
      [{ id: TOPIC, name: "topic", scope: "conversation", type: "number", sensitive: false }],
    );
    const v2 = await publish(c, "v2");
    await goLive(c, v1, {
      ...emptyState(),
      status: "waiting_input",
      stack: [{ workflowId: old?.wf, nodeId: old?.id, cardIndex: 1, vars: {}, inputs: {} }],
      wait: { kind: "listen", nodeId: old?.id, since: "2026-11-14T10:00:00.000Z" },
      conversationVars: { [TOPIC]: "طلب" },
    });
    await send(c, "أنا رجعت");
    expect(await drainConversation(deps().d, c.conversationId)).toEqual({ turns: 1, stopped: "drained" });
    // The stack was cleared, so the message started the new version from Start.
    expect(await botTexts(c)).toEqual(["جديد"]);
    const [conv] = await query<{ version_id: string; state: { conversationVars: Record<string, unknown> } }>(
      "select version_id, state from conversations where id = $1",
      [c.conversationId],
    );
    expect(conv?.version_id).toBe(v2);
    expect(conv?.state.conversationVars).toEqual({});
    const [migrated] = (await spansOf(c)).filter((s) => s.kind === "version.migrated");
    expect(migrated?.attrs).toEqual({
      fromVersionId: v1,
      toVersionId: v2,
      positionKept: false,
      dropped: [{ scope: "conversation", id: TOPIC, name: "topic" }],
    });
  });

  test("an emulator conversation keeps running the draft", async () => {
    const c = await seed([card({ type: "say", message: { type: "text", text: "مسودة" } })]);
    await publish(c, "v1");
    await send(c, "أهلاً");
    await drainConversation(deps().d, c.conversationId);
    const [conv] = await query<{ version_id: string | null }>("select version_id from conversations where id = $1", [
      c.conversationId,
    ]);
    expect(conv?.version_id).toBeNull();
    expect((await spansOf(c)).some((s) => s.kind === "version.migrated")).toBe(false);
  });
});

describe("config variables (task 7.3, ADR-037)", () => {
  const ring: Keyring = { current: { version: 1, key: new Uint8Array(randomBytes(32)) } };
  const CANARY = "canary-worker-5b8e2d91";

  test("the draft runs with draft values, and a secret that reaches the trace is scrubbed from every span", async () => {
    const c = await seed([card({ type: "code", source: "log.info(env.SHOP_TOKEN)" })]);
    await db.withWorkspace(c.ws, async (tx) => {
      const m = await getDraftDoc(tx, c.botId, "manifest", "manifest");
      await saveDraftDoc(tx, {
        botId: c.botId,
        kind: "manifest",
        docId: "manifest",
        expectedRev: m.rev,
        userId: null,
        doc: { ...(m.doc as object), configVars: [{ key: "SHOP_TOKEN", secret: true }] },
      });
      const put = (env: "draft" | "production", value: string) =>
        putConfigValue(tx, ring, {
          workspaceId: c.ws,
          botId: c.botId,
          env,
          key: "SHOP_TOKEN",
          value,
          isSecret: true,
          userId: null,
        });
      await put("draft", CANARY);
      await put("production", "production-only-value");
    });
    const seen: unknown[] = [];
    // A guest that leaks the secret into its logs (the real sandbox redacts by key; this one does not).
    const code: CodePort = {
      run: async (req: CodeRequest) => {
        seen.push((req.scopes as { env?: unknown }).env);
        return { ...ok(), logs: [{ level: "info", args: [`token is ${CANARY}`] }] };
      },
    };
    await send(c, "أهلاً");
    await drainConversation(deps({ code, keyring: ring }).d, c.conversationId);
    expect(seen).toEqual([{ SHOP_TOKEN: CANARY }]);
    const raw = await query<{ attrs: unknown }>("select attrs from trace_spans where conversation_id = $1", [
      c.conversationId,
    ]);
    expect(raw.length).toBeGreaterThan(0);
    expect(JSON.stringify(raw)).not.toContain(CANARY);
    expect(JSON.stringify(raw)).toContain("[redacted]");
  });
});

describe("knowledge search in committed turns", () => {
  async function knowledgeFixture(kind: "card" | "tool" = "card") {
    const kbId = newId("kb");
    const answerInto = newElementId("var");
    const c = await seed([card({ type: "kb_search", kbIds: [kbId], answer: { into: answerInto, send: true } })], {
      models: { default: "openai:fixture", utility: "openai:fixture" },
    });
    await db.withWorkspace(c.ws, async (tx) => {
      const manifest = await getDraftDoc(tx, c.botId, "manifest", "manifest");
      await saveDraftDoc(tx, {
        botId: c.botId,
        kind: "manifest",
        docId: "manifest",
        userId: c.userId,
        expectedRev: manifest.rev,
        doc: {
          ...(manifest.doc as object),
          variables: [{ id: answerInto, name: "answer", scope: "conversation", type: "object" }],
        },
      });
      const kb = await createKnowledgeBase(tx, {
        botId: c.botId,
        name: "السياسة",
        embeddingModel: "openai:embedding-fixture",
      });
      // Replace the declared fixture KB before it is run, using the real store command boundary.
      const docs = await listDraftDocs(tx, c.botId);
      const main = docs.find((d) => d.kind === "workflow");
      if (!main) throw new Error("missing fixture main");
      const workflow = Workflow.parse(JSON.parse(JSON.stringify(main.doc).replaceAll(kbId, kb.id)));
      const node = workflow.nodes[1];
      if (kind === "tool" && node)
        workflow.nodes[1] = {
          id: node.id,
          type: "autonomous",
          name: "Assistant",
          instructions: "Search the declared policy tool, then answer with citations.",
          model: "openai:gpt-4.1-mini",
          tools: [
            {
              id: newElementId("tool"),
              type: "kb_search",
              name: "searchHelp",
              description: "Finds the store policy.",
              kbIds: [kb.id],
              topK: 1,
            },
          ],
        } as typeof node;
      await saveDraftDoc(tx, {
        botId: c.botId,
        kind: "workflow",
        docId: main.docId,
        userId: c.userId,
        expectedRev: main.rev,
        doc: workflow,
      });
      const source = await createSource(tx, { kbId: kb.id, kind: "text", config: {} });
      const document = await upsertDocument(tx, {
        kbId: kb.id,
        sourceId: source.id,
        uri: "https://example.test/policy",
        title: "الاسترجاع",
      });
      await updateDocument(tx, document.id, { status: "ready", lang: "ar" });
      await replaceChunks(tx, {
        kbId: kb.id,
        documentId: document.id,
        indexVersion: 1,
        rows: [
          {
            ordinal: 0,
            text: "يمكن الاسترجاع خلال ١٤ يومًا",
            textNorm: "استرجاع 14 يوم",
            lexTokens: "استرجاع 14 يوم",
            headingPath: ["سياسة"],
            embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
            tokenCount: 7,
            meta: {},
          },
        ],
      });
      await updateWorkspace(tx, { settings: { rerankModel: "tei:rerank-fixture" } });
    });
    return c;
  }
  const usage = { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  const calls: unknown[] = [];
  const llm: Pick<LlmClient, "embed" | "rerank"> = {
    embed: async (r) => {
      calls.push(r);
      return { embeddings: [Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))], model: r.model, usage };
    },
    rerank: async (r) => {
      calls.push(r);
      return r.documents.map((_, index) => ({ index, score: 0.9 }));
    },
  };
  test("persists Arabic answer citations and every retrieval stage with emulator context", async () => {
    calls.length = 0;
    const c = await knowledgeFixture();
    let knowledge: KnowledgePort | undefined;
    const { d } = deps({
      knowledge: (turn, record) => {
        knowledge = turnKnowledge({ db, llm, now: () => 1000 }, turn, record);
        return knowledge;
      },
      enginePorts: () => ({
        sandbox: noSandbox,
        code: { run: async () => ok() },
        ai: { complete: async () => ({ text: "يمكن إرجاع الطلب خلال ١٤ يومًا [[c1]]", model: "fixture" }) },
      }),
    });
    await send(c, "إزاي أرجّع الأوردر ORD-12؟");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["يمكن إرجاع الطلب خلال ١٤ يومًا"]);
    const [message] = await query<{ citations: unknown[] }>(
      "select citations from messages where conversation_id=$1 and direction='out'",
      [c.conversationId],
    );
    expect(message?.citations).toMatchObject([
      { index: 1, title: "الاسترجاع", snippet: "يمكن الاسترجاع خلال ١٤ يومًا" },
    ]);
    const spans = await spansOf(c);
    const search = spans.find((s) => s.kind === "kb.search");
    expect(search?.status).toBe("ok");
    expect(search?.attrs).toMatchObject({
      dense: { inline: true, value: [{ chunkId: expect.any(String), score: 1 }] },
      lexical: { inline: true },
      fused: { inline: true },
      reranked: { inline: true, value: [{ chunkId: expect.any(String), score: 0.9 }] },
      returned: 1,
    });
    expect(calls).toHaveLength(2);
    for (const request of calls)
      expect(request).toMatchObject({ context: { workspaceId: c.ws, botId: c.botId, mode: "emulator" } });
    if (!knowledge || !search) throw new Error("missing search fixture");
    const resolved = await db.withWorkspace(c.ws, (tx) =>
      tx.execute(sql`select id from knowledge_bases where bot_id=${c.botId}`),
    );
    const kbIds = resolved.rows.map((r) => String(r["id"]));
    const [a, b] = await Promise.all([
      knowledge.search({ query: "الاسترجاع", kbIds, topK: 1 }),
      knowledge.search({ query: "refund", kbIds, topK: 1 }),
    ]);
    expect(a.passages[0]?.cite).toBe("[[c2]]");
    expect(b.passages[0]?.cite).toBe("[[c3]]");
    expect(Object.keys(b.citations.sources)).toEqual(["c1", "c2", "c3"]);
  });
  test("an explicitly declared knowledge tool carries citations across autonomy iterations", async () => {
    const c = await knowledgeFixture("tool");
    const model = new FakeLlm()
      .scriptText(':::run\nreturn await tools.searchHelp("إزاي أرجع الأوردر؟")\n:::end')
      .scriptText(":::say text\nالاسترجاع خلال ١٤ يومًا [[c1]]\n:::exit listen\n:::end");
    const fullLlm: LlmClient = {
      ...llm,
      stream: (r) => {
        const handle = model.stream(r);
        return {
          textStream: handle.textStream,
          result: handle.result.then((out) => ({
            ...out,
            model: r.model,
            costMicroUsd: 0,
            usage: { ...out.usage, cacheWriteTokens: 0 },
          })),
        };
      },
      readImage: async () => {
        throw new Error("not an OCR test");
      },
    };
    const { d } = deps({
      knowledge: (turn, record) => turnKnowledge({ db, llm: fullLlm }, turn, record),
      autonomy: (turn, code, knowledge) =>
        autonomyPort(
          {
            db,
            llm: fullLlm,
            knowledge,
            logger,
            runPort: {
              run: async (r) => {
                const value = await r.onTool({ tool: "searchHelp", input: "إزاي أرجع الأوردر؟" });
                return { ok: true, value, patches: {}, logs: [] };
              },
            },
          },
          turn,
          code,
        ),
    });
    await send(c, "إزاي أرجع الأوردر ORD-12؟");
    await drainConversation(d, c.conversationId);
    expect(await botTexts(c)).toEqual(["الاسترجاع خلال ١٤ يومًا"]);
    const [message] = await query<{ citations: unknown[] }>(
      "select citations from messages where conversation_id=$1 and direction='out'",
      [c.conversationId],
    );
    expect(message?.citations).toMatchObject([{ title: "الاسترجاع", index: 1 }]);
    const spans = await spansOf(c);
    expect(spans.filter((s) => s.kind === "kb.search")).toHaveLength(1);
    expect(spans.find((s) => s.kind === "tool.call")?.attrs).toMatchObject({
      name: "searchHelp",
      toolType: "kb_search",
    });
    model.expectDone();
  });
});

test("table runtime mutations do not repeat across retries or run against live data from emulator", async () => {
  const c = await seed([]);
  const event = await send(c, "أضيف مرتجع ORD-12");
  const { table, turn, epoch } = await db.withWorkspace(c.ws, async (tx) => {
    const table = await createTable(tx, c.botId, {
      name: "orders",
      columns: [
        { id: newElementId("col"), name: "title", type: "string", required: true, unique: false, searchable: true },
      ],
    });
    await tx.execute(sql`update conversations set mode = 'live' where id = ${c.conversationId}`);
    const epoch = await acquireConversationLease(tx, c.conversationId, "runtime-test", 30_000);
    if (epoch === undefined) throw new Error("could not take the fixture lease");
    const turn = await startTurn(tx, {
      conversationId: c.conversationId,
      botId: c.botId,
      versionId: null,
      epoch,
      eventIds: [event.id],
    });
    return { table, turn, epoch };
  });
  const base = { workspaceId: c.ws, botId: c.botId, conversationId: c.conversationId, turnId: turn.id, epoch };
  const live = () => turnTables(db, { ...base, mode: "live" }, () => {});
  const request = {
    target: { id: table.id },
    operation: "insert" as const,
    surface: "code" as const,
    input: { values: { title: "مرتجع ORD-12" } },
    idempotencyKey: `${turn.id}:1`,
  };
  const inserted = await live().execute(request);
  expect(await live().execute(request)).toEqual(inserted);
  await expect(live().execute({ ...request, input: { values: { title: "كتاب مختلف" } } })).rejects.toMatchObject({
    code: "table_replay_conflict",
  });
  for (const mode of ["emulator", "eval"] as const) {
    await expect(turnTables(db, { ...base, mode }, () => {}).execute(request)).rejects.toMatchObject({
      code: "table_write_disabled",
    });
  }
  await expect(
    turnTables(db, { ...base, mode: "live", epoch: epoch + 1 }, () => {}).execute(request),
  ).rejects.toThrow();
  const read = { ...request, operation: "find" as const, input: { search: "مرتجع ORD 12" } };
  expect(await turnTables(db, { ...base, mode: "emulator" }, () => {}).execute(read)).toEqual([inserted]);
});

test("redacts large Arabic trace payloads, scopes the reference and retries expiry", async () => {
  const secret = "trace-test-canary";
  const text = "فاتورة ORD-12 ".repeat(1200);
  const c = await seed([card({ type: "code", source: `// ${text}` })]);
  const other = await seed([]);
  const store = memoryObjectStore();
  await send(c, "مرحبا");
  const code: CodePort = { run: async () => ({ ...ok(), logs: [{ level: "info", args: [secret, text] }] }) };
  await drainConversation(
    deps({ code, traceStore: store, tracePiiPatterns: [/trace-test-canary/gu] }).d,
    c.conversationId,
  );
  const spans = await query<{ id: string; turn_id: string; attrs: unknown; payload_key: string | null }>(
    "select id, turn_id, attrs, payload_key from trace_spans where conversation_id = $1 and kind = 'code.exec'",
    [c.conversationId],
  );
  const span = spans[0];
  if (!span?.payload_key) throw new Error("Code span is missing its payload bundle");
  const payload = new TextDecoder().decode(await store.get(span.payload_key));
  expect(JSON.parse(payload)).toMatchObject({ source: `// ${text}`, logs: [{ message: "[redacted]", data: [text] }] });
  expect(JSON.stringify([span.attrs, payload])).not.toContain(secret);
  expect(await db.withWorkspace(c.ws, (tx) => tracePayloadKey(tx, span.turn_id, span.id, "logs"))).toBe(
    span.payload_key,
  );
  expect(await db.withWorkspace(other.ws, (tx) => tracePayloadKey(tx, span.turn_id, span.id, "logs"))).toBeUndefined();

  await su("update trace_spans set started_at = $1 where conversation_id = $2", [
    new Date(Date.now() - 31 * 86_400_000),
    c.conversationId,
  ]);
  const later = new Date();
  let failed = 0;
  await maintainTraces(
    db,
    {
      delete: async () => {
        throw new Error("test store temporarily unavailable");
      },
    },
    later,
    {},
    () => {
      failed++;
    },
  );
  expect(failed).toBeGreaterThan(0);
  expect(store.objects.has(span.payload_key)).toBe(true);
  await maintainTraces(db, store, later, {}, () => {
    throw new Error("retry should succeed");
  });
  expect(store.objects.has(span.payload_key)).toBe(false);
  const partitions = await query<{ next_month: string | null }>(
    "select to_regclass('public.trace_spans_' || to_char(date_trunc('month', now() at time zone 'UTC') + interval '1 month', 'YYYY_MM'))::text as next_month",
    [],
  );
  expect(partitions[0]?.next_month).toMatch(/^trace_spans_/);
});

test("a fresh replay leaves its live source unchanged and blocks Code cards until confirmed", async () => {
  const c = await seed([card({ type: "code", source: "return 1;" })]);
  let calls = 0;
  const code: CodePort = {
    run: async () => {
      calls++;
      return ok();
    },
  };
  for (const allowed of [false, true]) {
    const event = await send(c, "إعادة ORD-12");
    await db.withWorkspace(c.ws, (tx) =>
      tx.execute(sql`update inbound_events set payload = payload ||
      ${JSON.stringify({ replay: { sourceTurnId: newId("turn"), allowSideEffects: allowed, group: newId("turn") } })}::jsonb
      where id=${event.id}`),
    );
    await drainConversation(deps({ code }).d, c.conversationId);
    expect(calls).toBe(allowed ? 1 : 0);
  }
});
