import { Writable } from "node:stream";
import { newId } from "@wakeel/contracts";
import {
  createBot,
  createDatabase,
  createFile,
  createKnowledgeBase,
  createSource,
  createWorkspace,
  type Database,
  getDocument,
  getStages,
  markFileReady,
  memoryObjectStore,
  sql,
  upsertDocument,
} from "@wakeel/db";
import { type StartedTestDatabase, startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import type { ParserPort, ParserResponse } from "@wakeel/retrieval";
import { createLogger } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanMarkdown, type IngestDeps, type IngestJob, ingestDocument, runStage } from "../src/kb/ingest";

/**
 * Task 8.4 acceptance against real Postgres: re-ingesting an unchanged document does no work; a
 * failed embed resumes from that stage. Also: chunks land with their lexical vector and embedding,
 * an Arabic PDF page goes through the OCR tier, and a changed document is re-indexed.
 */
let database: StartedTestDatabase;
let db: Database;
const logger = createLogger({
  service: "worker",
  level: "silent",
  destination: new Writable({ write: (_c, _e, d) => d() }),
});

beforeAll(async () => {
  database = await startTestDatabase();
  db = createDatabase({ url: database.urls.rw, maxConnections: 6 });
});
afterAll(async () => {
  await db?.close();
  await database?.stop();
});

const MD = `# دليل خدمة العملاء

## سياسة الاسترجاع

يمكن استرجاع المنتج خلال ١٤ يومًا من تاريخ الاستلام بشرط أن يكون في عبوته الأصلية.

## الأسعار

| الباقة | السعر |
| --- | --- |
| العائلية | 450 جنيه |
`;

/** A harness: the pipeline with fakes for the parser, OCR and embeddings, and an in-memory queue. */
function harness() {
  const store = memoryObjectStore();
  const queue: IngestJob[] = [];
  const calls = { embed: 0, parse: 0, ocr: 0, failEmbed: 0 };
  const parser: ParserPort = {
    async parse() {
      calls.parse++;
      const res: ParserResponse = {
        title: null,
        pageCount: 1,
        pages: [{ number: 1, markdown: "1 رقم منتج", chars: 600, image: "iVBORw==", ocrReason: "arabic" }],
        tables: [],
        headings: [],
      };
      return res;
    },
  };
  const deps: IngestDeps = {
    db,
    objectStore: store,
    parser,
    ocr: async () => ({
      ocrPage: async () => {
        calls.ocr++;
        return "# قائمة الأسعار\n\n| المنتج | الحالة |\n| --- | --- |\n| منتج رقم 1 | غير متوفر |";
      },
    }),
    embed: () => async (values) => {
      calls.embed++;
      if (calls.failEmbed > 0) {
        calls.failEmbed--;
        throw new Error("provider down");
      }
      // 1536 dimensions, as some providers answer; the embedder fits them to 1024.
      return values.map((v, i) => Array.from({ length: 1536 }, (_, d) => ((v.length + i + d) % 7) + 1));
    },
    enqueue: async (job) => void queue.push(job),
    logger,
  };
  /** Runs jobs until the queue is empty; a failing job is retried like BullMQ would, up to 5 times. */
  async function drain() {
    const outcomes: string[] = [];
    while (queue.length) {
      const job = queue.shift() as IngestJob;
      for (let attempt = 1; ; attempt++) {
        try {
          outcomes.push(`${job.stage}:${await runStage(deps, job)}`);
          break;
        } catch (e) {
          outcomes.push(`${job.stage}:failed`);
          if (attempt >= 5) throw e;
        }
      }
    }
    return outcomes;
  }
  return { deps, store, queue, calls, drain };
}

async function tenant() {
  const userId = newId("usr");
  await superuserQuery(database.urls, "insert into users (id, email, name) values ($1, $2, 'KB')", [
    userId,
    `${userId}@example.test`,
  ]);
  const { workspace } = await createWorkspace(db, { name: "KB", slug: `kb-${userId.slice(-8)}`, ownerUserId: userId });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "دليل", slug: "guide", createdBy: userId }));
  const kb = await db.withWorkspace(ws, (tx) =>
    createKnowledgeBase(tx, { botId: bot.id, name: "الأسئلة", embeddingModel: "openai:text-embedding-3-large" }),
  );
  return { ws, userId, bot, kb };
}

async function textDocument(t: Awaited<ReturnType<typeof tenant>>, text: string) {
  return db.withWorkspace(t.ws, async (tx) => {
    const src = await createSource(tx, { kbId: t.kb.id, kind: "text", config: { text } });
    return upsertDocument(tx, { kbId: t.kb.id, sourceId: src.id, uri: "دليل.md" });
  });
}

describe("ingestion pipeline", () => {
  test("runs every stage once and indexes chunks with headings, lexical vectors and 1024-d embeddings", async () => {
    const t = await tenant();
    const h = harness();
    const doc = await textDocument(t, MD);
    await ingestDocument(h.deps, t.ws, doc.id);
    expect(await h.drain()).toEqual([
      "fetch:done",
      "parse:done",
      "normalise:done",
      "chunk:done",
      "embed:done",
      "index:done",
    ]);
    const after = await db.withWorkspace(t.ws, (tx) => getDocument(tx, doc.id));
    expect(after).toMatchObject({ status: "ready", title: "دليل خدمة العملاء" });
    expect(after.tokenCount).toBeGreaterThan(0);
    const rows = await db.withWorkspace(t.ws, async (tx) => {
      const r = await tx.execute(
        sql`select heading_path, text, lex::text as lex, vector_dims(embedding) as dims,
          round((embedding <#> embedding)::numeric, 3) as neg_norm from kb_chunks where document_id = ${doc.id} order by ordinal`,
      );
      return r.rows as { heading_path: string[]; text: string; lex: string; dims: number; neg_norm: string }[];
    });
    expect(rows.map((r) => r.heading_path)).toEqual([
      ["دليل خدمة العملاء", "سياسة الاسترجاع"],
      ["دليل خدمة العملاء", "الأسعار"],
    ]);
    expect(rows[1]?.text).toContain("| العائلية | 450 جنيه |");
    // The lexical vector holds our normalised, stemmed tokens: "الاسترجاع" → "استرجاع", "يومًا" → "يوما".
    expect(rows[0]?.lex).toContain("'استرجاع'");
    expect(rows.every((r) => r.dims === 1024 && r.neg_norm === "-1.000")).toBe(true);
    const stages = await db.withWorkspace(t.ws, (tx) => getStages(tx, doc.id));
    expect(stages.map((s) => [s.stage, s.status, s.attempts]).sort()).toEqual(
      ["chunk", "embed", "fetch", "index", "normalise", "parse"].map((s) => [s, "done", 1]),
    );
  });

  test("re-ingesting an unchanged document does no work", async () => {
    const t = await tenant();
    const h = harness();
    const doc = await textDocument(t, MD);
    await ingestDocument(h.deps, t.ws, doc.id);
    await h.drain();
    const embedsBefore = h.calls.embed;
    const objectsBefore = h.store.objects.size;
    await ingestDocument(h.deps, t.ws, doc.id);
    expect(await h.drain()).toEqual(["fetch:unchanged"]);
    expect(h.calls.embed).toBe(embedsBefore);
    expect(h.store.objects.size).toBe(objectsBefore);
  });

  test("a failed embed resumes from the embed stage, without fetching, parsing or chunking again", async () => {
    const t = await tenant();
    const h = harness();
    const doc = await textDocument(t, MD);
    h.calls.failEmbed = 2;
    await ingestDocument(h.deps, t.ws, doc.id);
    expect(await h.drain()).toEqual([
      "fetch:done",
      "parse:done",
      "normalise:done",
      "chunk:done",
      "embed:failed",
      "embed:failed",
      "embed:done",
      "index:done",
    ]);
    const stages = await db.withWorkspace(t.ws, (tx) => getStages(tx, doc.id));
    const byStage = Object.fromEntries(stages.map((s) => [s.stage, s]));
    expect(byStage["embed"]).toMatchObject({ status: "done", attempts: 3 });
    expect(byStage["chunk"]).toMatchObject({ status: "done", attempts: 1 });
    expect(byStage["parse"]).toMatchObject({ attempts: 1 });
    expect((await db.withWorkspace(t.ws, (tx) => getDocument(tx, doc.id))).status).toBe("ready");
  });

  test("a stage that failed for good leaves the document failed with the reason", async () => {
    const t = await tenant();
    const h = harness();
    const doc = await textDocument(t, MD);
    h.calls.failEmbed = 99;
    await ingestDocument(h.deps, t.ws, doc.id);
    await expect(h.drain()).rejects.toThrow("provider down");
    const after = await db.withWorkspace(t.ws, (tx) => getDocument(tx, doc.id));
    expect(after.status).toBe("failed");
    expect((after.meta as { error: { code: string } }).error.code).toBe("internal_error");
  });

  test("a changed document is re-indexed and its old chunks replaced", async () => {
    const t = await tenant();
    const h = harness();
    const doc = await textDocument(t, MD);
    await ingestDocument(h.deps, t.ws, doc.id);
    await h.drain();
    await db.withWorkspace(t.ws, (tx) =>
      tx.execute(sql`update kb_sources set config = ${JSON.stringify({ text: "# جديد\n\nسياسة جديدة." })}::jsonb
        where id = ${doc.sourceId}`),
    );
    await ingestDocument(h.deps, t.ws, doc.id);
    expect((await h.drain()).at(-1)).toBe("index:done");
    const texts = await db.withWorkspace(t.ws, async (tx) =>
      (await tx.execute(sql`select text from kb_chunks where document_id = ${doc.id}`)).rows.map((r) => r["text"]),
    );
    expect(texts).toEqual(["سياسة جديدة."]);
  });

  test("an uploaded Arabic PDF goes through the parser and the OCR tier; the file gets its sha256", async () => {
    const t = await tenant();
    const h = harness();
    const doc = await db.withWorkspace(t.ws, async (tx) => {
      const f = await createFile(tx, {
        workspaceId: t.ws,
        botId: t.bot.id,
        purpose: "kb_source",
        name: "أسعار.pdf",
        mime: "application/pdf",
        size: 8,
        createdBy: t.userId,
      });
      await h.store.put(f.key, new TextEncoder().encode("%PDF-1.7"), "application/pdf");
      await markFileReady(tx, f.id);
      const src = await createSource(tx, { kbId: t.kb.id, kind: "file", config: { fileId: f.id } });
      return upsertDocument(tx, { kbId: t.kb.id, sourceId: src.id, uri: "أسعار.pdf" });
    });
    await ingestDocument(h.deps, t.ws, doc.id);
    await h.drain();
    expect(h.calls).toMatchObject({ parse: 1, ocr: 1 });
    const chunk = await db.withWorkspace(t.ws, async (tx) =>
      (await tx.execute(sql`select text from kb_chunks where document_id = ${doc.id}`)).rows.map((r) => r["text"]),
    );
    expect(chunk.join("\n")).toContain("| منتج رقم 1 | غير متوفر |");
    const sha = await db.withWorkspace(
      t.ws,
      async (tx) =>
        (await tx.execute(sql`select sha256 from files where key like ${`ws/${t.ws}/%`}`)).rows[0]?.["sha256"],
    );
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a file that has not finished uploading fails fetch with upload_incomplete", async () => {
    const t = await tenant();
    const h = harness();
    const doc = await db.withWorkspace(t.ws, async (tx) => {
      const f = await createFile(tx, {
        workspaceId: t.ws,
        botId: t.bot.id,
        purpose: "kb_source",
        name: "a.pdf",
        mime: "application/pdf",
        size: 8,
        createdBy: t.userId,
      });
      const src = await createSource(tx, { kbId: t.kb.id, kind: "file", config: { fileId: f.id } });
      return upsertDocument(tx, { kbId: t.kb.id, sourceId: src.id, uri: "a.pdf" });
    });
    await ingestDocument(h.deps, t.ws, doc.id);
    await expect(h.drain()).rejects.toMatchObject({ code: "upload_incomplete" });
  });

  test("another workspace cannot run a stage on a document it does not own", async () => {
    const a = await tenant();
    const b = await tenant();
    const h = harness();
    const doc = await textDocument(a, MD);
    await expect(runStage(h.deps, { workspaceId: b.ws, documentId: doc.id, stage: "fetch" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("cleanMarkdown", () => {
  test("removes invisible formatting and control characters but keeps ZWJ and ZWNJ", () => {
    const zwnj = String.fromCharCode(0x200c);
    const zwsp = String.fromCharCode(0x200b);
    const rlm = String.fromCharCode(0x200f);
    const bom = String.fromCharCode(0xfeff);
    expect(cleanMarkdown(`${bom}مر${zwsp}حبا${rlm} می${zwnj}خواهم\n\n\n\nسطر   \nآخر`)).toBe(
      `مرحبا می${zwnj}خواهم\n\nسطر\nآخر`,
    );
  });
});
