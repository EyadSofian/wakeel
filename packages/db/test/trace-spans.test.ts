import { randomBytes } from "node:crypto";
import { emptyState, newId, Span } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  createBot,
  createDatabase,
  createWorkspace,
  type Database,
  listTurnSpans,
  sql,
  upsertSpans,
} from "../src/index";

/** Task 4.7 (ADR-009, ADR-026, migration 0008): trace spans, partitioned by month, under RLS. */
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

async function conversation() {
  const userId = newId("usr");
  await su.query("insert into users (id, email, name) values ($1, $2, 'Builder')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Traces",
    slug: `t-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "النور", slug: "noor", createdBy: userId }));
  const ids = { ws, botId: bot.id, conn: newId("conn"), eu: newId("eu"), conv: newId("conv"), turn: newId("turn") };
  await db.withWorkspace(ws, async (tx) => {
    await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target)
      values (${ids.conn}, ${ws}, ${ids.botId}, 'Emulator', 'draft')`);
    await tx.execute(sql`insert into end_users (id, workspace_id, bot_id, connection_id, external_id)
      values (${ids.eu}, ${ws}, ${ids.botId}, ${ids.conn}, 'u-1')`);
    await tx.execute(sql`insert into conversations (id, workspace_id, bot_id, connection_id, end_user_id, external_id, mode, status, state, state_bytes)
      values (${ids.conv}, ${ws}, ${ids.botId}, ${ids.conn}, ${ids.eu}, 'c-1', 'emulator', 'idle', ${JSON.stringify(emptyState())}::jsonb, 10)`);
  });
  return ids;
}

type Ids = Awaited<ReturnType<typeof conversation>>;

const spans = (ids: Ids, startedAt = "2026-11-14T10:00:00.000Z"): Span[] => {
  const base = {
    workspaceId: ids.ws,
    botId: ids.botId,
    conversationId: ids.conv,
    turnId: ids.turn,
    status: "ok" as const,
    startedAt,
    location: {},
  };
  const turnId = newId("span");
  return [
    {
      ...base,
      id: turnId,
      seq: 0,
      name: "Turn",
      durationMs: 0,
      kind: "turn",
      attrs: { trigger: "message", mode: "emulator" },
    },
    {
      ...base,
      id: newId("span"),
      parentId: turnId,
      seq: 1,
      name: "Greet",
      durationMs: 0,
      location: { workflowId: "wf_AAAAAAAAAA", nodeId: "node_AAAAAAAAAA" },
      kind: "node",
      attrs: { nodeType: "standard" },
    },
  ];
};

describe("upsertSpans and listTurnSpans", () => {
  test("a span is written when it opens and updated when it closes; reads come back ordered and parsed", async () => {
    const ids = await conversation();
    const [turn, node] = spans(ids) as [Span, Span];
    await db.withWorkspace(ids.ws, (tx) => upsertSpans(tx, [node, turn]));
    const closed = {
      ...turn,
      durationMs: 140,
      attrs: { trigger: "message", mode: "emulator", outcome: "waiting", stepCount: 4 },
    } as Span;
    await db.withWorkspace(ids.ws, (tx) => upsertSpans(tx, [closed]));
    const read = await db.withWorkspace(ids.ws, (tx) => listTurnSpans(tx, ids.turn));
    expect(read.map((s) => [s.seq, s.kind, s.durationMs])).toEqual([
      [0, "turn", 140],
      [1, "node", 0],
    ]);
    expect(read[0]).toEqual(closed);
    expect(read[1]).toEqual(node);
    for (const s of read) expect(Span.safeParse(s).success).toBe(true);
  });

  test("spans land in their month's partition, and outside the created months in the default one", async () => {
    const ids = await conversation();
    await db.withWorkspace(ids.ws, (tx) => upsertSpans(tx, [spans(ids)[0] as Span]));
    const later = { ...spans(ids, "2031-01-05T00:00:00.000Z")[0], id: newId("span"), turnId: newId("turn") } as Span;
    await db.withWorkspace(ids.ws, (tx) => upsertSpans(tx, [later]));
    const { rows } = await su.query(
      "select tableoid::regclass::text as part from trace_spans where conversation_id = $1 order by started_at",
      [ids.conv],
    );
    expect(rows.map((r) => r.part)).toEqual(["trace_spans_2026_11", "trace_spans_default"]);
  });

  test("a malformed span is refused before it is written", async () => {
    const ids = await conversation();
    const bad = { ...spans(ids)[0], attrs: { trigger: "nonsense" } } as unknown as Span;
    await expect(db.withWorkspace(ids.ws, (tx) => upsertSpans(tx, [bad]))).rejects.toThrow();
  });

  test("deleting the conversation deletes its spans", async () => {
    const ids = await conversation();
    await db.withWorkspace(ids.ws, (tx) => upsertSpans(tx, spans(ids)));
    await su.query("delete from conversations where id = $1", [ids.conv]);
    const { rows } = await su.query("select count(*)::int as n from trace_spans where turn_id = $1", [ids.turn]);
    expect(rows[0]).toEqual({ n: 0 });
  });
});

describe("two tenants", () => {
  test("another workspace can neither read nor write a workspace's spans", async () => {
    const a = await conversation();
    const b = await conversation();
    await db.withWorkspace(a.ws, (tx) => upsertSpans(tx, spans(a)));
    expect(await db.withWorkspace(b.ws, (tx) => listTurnSpans(tx, a.turn))).toEqual([]);
    // Writing A's span under B's workspace fails the policy's check.
    await expect(db.withWorkspace(b.ws, (tx) => upsertSpans(tx, spans(a)))).rejects.toThrow();
  });

  test("partitions cannot be read directly, and each has RLS enabled and forced", async () => {
    await expect(rw.query("select count(*) from trace_spans_2026_11")).rejects.toThrow(/permission denied/);
    await expect(rw.query("select count(*) from trace_spans_default")).rejects.toThrow(/permission denied/);
    const { rows } = await su.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'trace_spans'::regclass`);
    expect(rows.length).toBe(9);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });
});
