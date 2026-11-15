import { CreateFileResponse, TestKnowledgeResult } from "@wakeel/contracts";
import { getFile, replaceChunks, updateDocument, updateWorkspace, upsertDocument } from "@wakeel/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { STUDIO, type Stack, signUp, startStack } from "./stack";

let stack: Stack;
const queued: { workspaceId: string; sourceId: string }[] = [];
const vector = [1, ...Array<number>(1023).fill(0)];
beforeAll(async () => {
  stack = await startStack({
    knowledge: {
      enqueueSync: async (job) => {
        queued.push(job);
      },
      llm: {
        embed: async (request) => ({
          model: request.model,
          embeddings: [vector],
          usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 },
        }),
        rerank: async (request) => request.documents.map((_, index) => ({ index, score: 0.9 })),
      },
    },
  });
});
afterAll(async () => {
  await stack?.stop();
});

test("knowledge bases are bot-scoped and reject stale writes", async () => {
  const owner = await signUp(stack.app);
  const other = await signUp(stack.app);
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "Knowledge", slug: "knowledge" })).json().id;
  const bots = `/v1/workspaces/${ws}/bots`;
  const first = (await owner.send("POST", bots, { name: "الأول", slug: "first" })).json().id;
  const second = (await owner.send("POST", bots, { name: "الثاني", slug: "second" })).json().id;
  const base = `${bots}/${first}/knowledge-bases`;
  const result = await owner.send("POST", base, {
    name: "سياسة الاسترجاع",
    embeddingModel: "openai:text-embedding-3-large",
  });
  expect(result.statusCode, result.body).toBe(201);
  const item = result.json();
  const url = `${base}/${item.id}`;
  expect((await owner.get(`${bots}/${second}/knowledge-bases/${item.id}`)).statusCode).toBe(404);
  expect((await other.get(url)).statusCode).toBe(404);
  const patch = () =>
    stack.app.inject({
      method: "PATCH",
      url,
      payload: { name: "سياسة جديدة" },
      headers: {
        cookie: owner.cookie,
        origin: STUDIO,
        "x-csrf-token": owner.csrf,
        "if-match": String(result.headers["etag"]),
      },
    });
  expect((await patch()).statusCode).toBe(200);
  expect((await patch()).statusCode).toBe(409);
  expect((await owner.get(base)).json().data).toMatchObject([{ name: "سياسة جديدة" }]);
});

test("a completed file attaches to its bot and search returns Arabic passages and stages", async () => {
  const member = await signUp(stack.app);
  const ws = (await member.send("POST", "/v1/workspaces", { name: "Arabic KB", slug: "arabic-kb" })).json()
    .id as string;
  const root = `/v1/workspaces/${ws}`;
  const botId = (await member.send("POST", `${root}/bots`, { name: "المتجر", slug: "shop" })).json().id as string;
  const bases = `${root}/bots/${botId}/knowledge-bases`;
  const kbId = (
    await member.send("POST", bases, { name: "الإرجاع", embeddingModel: "openai:text-embedding-3-large" })
  ).json().id as string;
  const url = `${bases}/${kbId}`;
  const text = "استرجاع رسوم الطلب ORD-12 خلال ١٤ يومًا";
  const body = new TextEncoder().encode(text);
  const { file } = CreateFileResponse.parse(
    (
      await member.send("POST", `${root}/files`, {
        name: "سياسة.txt",
        mime: "text/plain",
        size: body.length,
        purpose: "kb_source",
        botId,
      })
    ).json(),
  );
  const source = { kind: "file", fileId: file.id };
  expect((await member.send("POST", `${url}/sources`, { source })).statusCode).toBe(409);
  const f = await stack.db.withWorkspace(ws, (tx) => getFile(tx, file.id));
  await stack.objectStore.put(f.key, body, "text/plain");
  expect((await member.send("POST", `${root}/files/${file.id}/complete`)).statusCode).toBe(200);
  const created = await member.send("POST", `${url}/sources`, { source });
  expect(created.statusCode, created.body).toBe(201);
  const sourceId = created.json().id as string;
  expect(queued).toContainEqual({ workspaceId: ws, sourceId });
  await stack.db.withWorkspace(ws, async (tx) => {
    await updateWorkspace(tx, { settings: { rerankModel: "bge-reranker-v2-m3" } });
    const doc = await upsertDocument(tx, { kbId, sourceId, uri: "fixture", title: file.name });
    await updateDocument(tx, doc.id, { status: "ready", lang: "ar" });
    await replaceChunks(tx, {
      kbId,
      documentId: doc.id,
      indexVersion: 1,
      rows: [
        {
          ordinal: 0,
          text,
          textNorm: text,
          lexTokens: "استرجاع رسوم طلب ord 12 14 يوم",
          headingPath: ["الإرجاع"],
          embedding: vector,
          tokenCount: 8,
          meta: {},
        },
      ],
    });
  });
  const result = await member.send("POST", `${url}/test-search`, { query: "استرجاع رسوم ORD-12" });
  expect(result.statusCode, result.body).toBe(200);
  const data = TestKnowledgeResult.parse(result.json());
  expect(data.passages[0]?.text).toBe(text);
  expect(data.trace.reranked[0]?.chunkId).toBe(data.passages[0]?.chunkId);
  expect((await member.send("POST", `${url}/test-search`, { query: "استرجاع", kbIds: [kbId] })).statusCode).toBe(400);
});
