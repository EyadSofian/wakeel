import { randomBytes } from "node:crypto";
import { newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { createBot, createDatabase, createFile, createWorkspace, type Database, getFile, sql } from "../src/index";

/**
 * Task 8.1 (migration 0015, ADR-039): every knowledge base table is invisible across tenants, and a
 * child row cannot point at another tenant's parent even with the right id, because the foreign
 * keys include workspace_id.
 */
const urls = inject("db");
let db: Database;
let bare: pg.Client;

const tenant = async () => {
  const userId = newId("usr");
  await bare.query("insert into users (id, email, name) values ($1, $2, 'KB')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "KB",
    slug: `kb-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const ws = workspace.id;
  const ids = { kb: newId("kb"), src: newId("src"), doc: newId("doc"), chk: newId("chk"), job: newId("ijob") };
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "دليل", slug: "guide", createdBy: userId }));
  const file = await db.withWorkspace(ws, async (tx) => {
    const f = await createFile(tx, {
      workspaceId: ws,
      botId: bot.id,
      purpose: "kb_source",
      name: "دليل.pdf",
      mime: "application/pdf",
      size: 10,
      createdBy: userId,
    });
    await tx.execute(sql`insert into knowledge_bases (id, workspace_id, bot_id, name, embedding_model)
      values (${ids.kb}, ${ws}, ${bot.id}, 'الأسئلة الشائعة', 'openai:text-embedding-3-large')`);
    await tx.execute(sql`insert into kb_sources (id, workspace_id, kb_id, kind, config)
      values (${ids.src}, ${ws}, ${ids.kb}, 'file', ${JSON.stringify({ fileId: f.id })}::jsonb)`);
    await tx.execute(sql`insert into kb_documents (id, workspace_id, kb_id, source_id, uri, title)
      values (${ids.doc}, ${ws}, ${ids.kb}, ${ids.src}, 'دليل.pdf', 'دليل المنتج')`);
    await tx.execute(sql`insert into kb_chunks (id, workspace_id, kb_id, document_id, ordinal, text, text_norm, lex, embedding, token_count, index_version)
      values (${ids.chk}, ${ws}, ${ids.kb}, ${ids.doc}, 0, 'مرحبا بكم', 'مرحب بكم', to_tsvector('simple', 'مرحب بكم'),
        ${`[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`}::vector, 3, 1)`);
    await tx.execute(sql`insert into kb_ingestion_jobs (id, workspace_id, kb_id, source_id, document_id, stage)
      values (${ids.job}, ${ws}, ${ids.kb}, ${ids.src}, ${ids.doc}, 'parse')`);
    return f;
  });
  return { ws, botId: bot.id, userId, fileId: file.id, ...ids };
};

const TABLES = ["files", "knowledge_bases", "kb_sources", "kb_documents", "kb_chunks", "kb_ingestion_jobs"] as const;

const count = (ws: string, table: string) =>
  db.withWorkspace(ws, async (tx) => {
    const r = await tx.execute(sql.raw(`select count(*)::int as n from ${table}`));
    return (r.rows[0] as { n: number }).n;
  });

/** Postgres error code through Drizzle's wrapping. */
const pgCode = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  let cur: unknown = e;
  while (cur instanceof Error && !("code" in cur) && cur.cause !== undefined) cur = cur.cause;
  return (cur as { code?: string } | undefined)?.code;
};

let a: Awaited<ReturnType<typeof tenant>>;
let b: Awaited<ReturnType<typeof tenant>>;

beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
  a = await tenant();
  b = await tenant();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

describe("knowledge base tables, two tenants", () => {
  test.each(TABLES)("%s: each tenant sees its own row only; no workspace sees nothing", async (table) => {
    expect(await count(a.ws, table)).toBe(1);
    expect(await count(b.ws, table)).toBe(1);
    expect((await bare.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
  });

  test("a file's key must be the platform's key for its own workspace and id", async () => {
    const f = await db.withWorkspace(a.ws, (tx) => getFile(tx, a.fileId));
    expect(f.key).toBe(`ws/${a.ws}/files/${a.fileId}`);
    const id = newId("file");
    const bad = db.withWorkspace(a.ws, (tx) =>
      tx.execute(sql`insert into files (id, workspace_id, purpose, name, key, mime, size)
        values (${id}, ${a.ws}, 'kb_source', 'x', ${`ws/${b.ws}/files/${id}`}, 'application/pdf', 1)`),
    );
    expect(await pgCode(bad)).toBe("23514");
  });

  test("B cannot read A's file by id", async () => {
    await expect(db.withWorkspace(b.ws, (tx) => getFile(tx, a.fileId))).rejects.toMatchObject({ code: "not_found" });
  });

  test("B cannot attach a source to A's knowledge base, nor a document to A's source", async () => {
    const src = db.withWorkspace(b.ws, (tx) =>
      tx.execute(sql`insert into kb_sources (id, workspace_id, kb_id, kind, config)
        values (${newId("src")}, ${b.ws}, ${a.kb}, 'text', '{}'::jsonb)`),
    );
    expect(await pgCode(src)).toBe("23503");
    const doc = db.withWorkspace(b.ws, (tx) =>
      tx.execute(sql`insert into kb_documents (id, workspace_id, kb_id, source_id, uri)
        values (${newId("doc")}, ${b.ws}, ${b.kb}, ${a.src}, 'x')`),
    );
    expect(await pgCode(doc)).toBe("23503");
  });

  test("B cannot write a row owned by A", async () => {
    const write = db.withWorkspace(b.ws, (tx) =>
      tx.execute(sql`insert into knowledge_bases (id, workspace_id, bot_id, name, embedding_model)
        values (${newId("kb")}, ${a.ws}, ${a.botId}, 'x', 'openai:x')`),
    );
    expect(await pgCode(write)).toBe("42501");
  });

  test("B's update and delete do not reach A's chunks", async () => {
    await db.withWorkspace(b.ws, (tx) => tx.execute(sql`update kb_chunks set text = 'x' where id = ${a.chk}`));
    await db.withWorkspace(b.ws, (tx) => tx.execute(sql`delete from kb_chunks where id = ${a.chk}`));
    const r = await db.withWorkspace(a.ws, (tx) => tx.execute(sql`select text from kb_chunks where id = ${a.chk}`));
    expect(r.rows).toEqual([{ text: "مرحبا بكم" }]);
  });

  test("deleting a knowledge base removes its sources, documents, chunks and jobs", async () => {
    const t = await tenant();
    await db.withWorkspace(t.ws, (tx) => tx.execute(sql`delete from knowledge_bases where id = ${t.kb}`));
    for (const table of TABLES.slice(1)) expect(await count(t.ws, table)).toBe(0);
    expect(await count(t.ws, "files")).toBe(1);
  });

  test("the HNSW and GIN indexes exist", async () => {
    const r = await bare.query(
      "select indexname, indexdef from pg_indexes where tablename = 'kb_chunks' and indexname in ('kb_chunks_embedding_idx', 'kb_chunks_lex_idx') order by indexname",
    );
    expect(r.rows.map((x) => x.indexname)).toEqual(["kb_chunks_embedding_idx", "kb_chunks_lex_idx"]);
    expect(r.rows[0].indexdef).toMatch(/USING hnsw .*vector_cosine_ops/);
    expect(r.rows[1].indexdef).toMatch(/USING gin/);
  });
});
