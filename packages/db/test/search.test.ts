import { randomBytes } from "node:crypto";
import { newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import {
  createBot,
  createDatabase,
  createKnowledgeBase,
  createSource,
  createWorkspace,
  type Database,
  replaceChunks,
  updateDocument,
  upsertDocument,
} from "../src/index";
import { resolveSearchBases, searchCandidates } from "../src/repos/search";

const urls = inject("db");
let db: Database;
let bare: pg.Client;
const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));

async function tenant() {
  const userId = newId("usr");
  await bare.query("insert into users (id,email,name) values ($1,$2,'Search')", [userId, `${userId}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Search",
    slug: `search-${randomBytes(4).toString("hex")}`,
    ownerUserId: userId,
  });
  const data = await db.withWorkspace(workspace.id, async (tx) => {
    const bot = await createBot(tx, { name: "دليل", slug: "guide", createdBy: userId });
    const otherBot = await createBot(tx, { name: "آخر", slug: "other", createdBy: userId });
    const rows = [];
    for (const [i, botId] of [bot.id, bot.id, otherBot.id].entries()) {
      const kb = await createKnowledgeBase(tx, { botId, name: `KB ${i}`, embeddingModel: "openai:embedding-fixture" });
      const source = await createSource(tx, { kbId: kb.id, kind: "text", config: {} });
      const doc = await upsertDocument(tx, {
        kbId: kb.id,
        sourceId: source.id,
        uri: `https://example.test/${i}`,
        title: "الاسترجاع",
      });
      await updateDocument(tx, doc.id, { status: "ready", lang: i ? "en" : "ar" });
      for (const indexVersion of [1, 2])
        await replaceChunks(tx, {
          kbId: kb.id,
          documentId: doc.id,
          indexVersion,
          rows: [
            {
              ordinal: 0,
              headingPath: ["سياسة"],
              text: "الاسترجاع خلال ١٤ يوم",
              textNorm: "استرجاع 14 يوم",
              lexTokens: "استرجاع 14 يوم",
              embedding: vector,
              tokenCount: 5,
              meta: {},
            },
          ],
        });
      rows.push({ kb, source, doc });
    }
    return { bot, otherBot, rows };
  });
  return { workspace, ...data };
}
let a: Awaited<ReturnType<typeof tenant>>;
let b: Awaited<ReturnType<typeof tenant>>;
beforeAll(async () => {
  db = createDatabase({ url: urls.rw, maxConnections: 3 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
  a = await tenant();
  b = await tenant();
});
afterAll(async () => {
  await bare?.end();
  await db?.close();
});

describe("hybrid candidates on real Postgres", () => {
  test("resolves all KBs under the bot and tenant boundary", async () => {
    const own = a.rows[0];
    if (!own) throw new Error("missing fixture");
    expect(await db.withWorkspace(a.workspace.id, (tx) => resolveSearchBases(tx, a.bot.id, [own.kb.id]))).toHaveLength(
      1,
    );
    await expect(
      db.withWorkspace(b.workspace.id, (tx) => resolveSearchBases(tx, b.bot.id, [own.kb.id])),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      db.withWorkspace(a.workspace.id, (tx) => resolveSearchBases(tx, a.otherBot.id, [own.kb.id])),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  test("both legs exclude other KBs and inactive index versions", async () => {
    const own = a.rows[0];
    if (!own) throw new Error("missing fixture");
    const result = await db.withWorkspace(a.workspace.id, (tx) =>
      searchCandidates(tx, a.bot.id, { kbIds: [own.kb.id], vector, tokens: ["استرجاع"] }),
    );
    for (const leg of [result.dense, result.lexical]) {
      expect(leg).toHaveLength(1);
      expect(leg[0]).toMatchObject({
        kbId: own.kb.id,
        documentId: own.doc.id,
        sourceId: own.source.id,
        title: "الاسترجاع",
      });
    }
  });
  test("document, source and language filters constrain both legs", async () => {
    const own = a.rows[0];
    if (!own) throw new Error("missing fixture");
    const run = (filters: { languages?: string[]; documentIds?: string[]; sourceIds?: string[] }) =>
      db.withWorkspace(a.workspace.id, (tx) =>
        searchCandidates(tx, a.bot.id, { kbIds: [own.kb.id], vector, tokens: ["استرجاع"], filters }),
      );
    expect(
      (await run({ languages: ["ar"], documentIds: [own.doc.id], sourceIds: [own.source.id] })).lexical,
    ).toHaveLength(1);
    for (const filters of [{ languages: ["en"] }, { documentIds: [newId("doc")] }, { sourceIds: [newId("src")] }])
      expect(await run(filters)).toEqual({ dense: [], lexical: [] });
  });
  test("tenant query text remains parameters and cannot broaden a search", async () => {
    const own = a.rows[0];
    if (!own) throw new Error("missing fixture");
    const result = await db.withWorkspace(b.workspace.id, (tx) =>
      searchCandidates(tx, b.bot.id, { kbIds: [own.kb.id], vector, tokens: ["') OR true --"] }),
    );
    expect(result).toEqual({ dense: [], lexical: [] });
  });
});
