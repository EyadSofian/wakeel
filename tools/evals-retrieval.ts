import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { AppError, newId } from "@wakeel/contracts";
import {
  createBot,
  createDatabase,
  createKnowledgeBase,
  createSource,
  createWorkspace,
  replaceChunks,
  resolveSearchBases,
  searchCandidates,
  updateDocument,
  upsertDocument,
} from "@wakeel/db";
import { startTestDatabase, superuserQuery } from "@wakeel/db/testing";
import { createLlm, registry, type UsageEvent } from "@wakeel/llm";
import { createSearch, embedAll, lexicalTokens, normalizeArabic, type RetrievalTrace } from "@wakeel/retrieval";
import { rewriteRequest } from "../packages/autonomy/src/knowledge/auto-search";
import { corpus } from "../packages/retrieval/evals/corpus";
import { realisticChunks, runRealisticSuite } from "../packages/retrieval/evals/realistic/index";
import { runRetrievalSuite } from "../packages/retrieval/evals/runner";
import { embeddingInput } from "../packages/retrieval/src/chunk";

/** One indexed document of a golden set and its chunks, each tagged with its golden key. */
interface FixtureDocument {
  title: string;
  uri: string;
  items: { key: string; headingPath: string[]; text: string; input: string }[];
}

/**
 * The synthetic set (8.7) is one document of short passages, embedded as before so its baseline
 * stays comparable. The realistic set (8.9) is one document per course page, split by the production
 * chunker and embedded with the production embedding input.
 */
function fixtureDocuments(set: "synthetic" | "realistic"): FixtureDocument[] {
  if (set === "synthetic")
    return [
      {
        title: "دليل أكاديمية السراج",
        uri: "https://example.test/golden",
        items: corpus.map((item) => ({
          key: item.key,
          headingPath: [...item.headingPath],
          text: item.text,
          input: [...item.headingPath, item.text].join("\n"),
        })),
      },
    ];
  const chunks = realisticChunks();
  return [...new Set(chunks.map((c) => c.page))].map((page) => ({
    title: page.title,
    uri: page.uri,
    items: chunks
      .filter((c) => c.page === page)
      .map((c) => ({ key: c.key, headingPath: c.headingPath, text: c.text, input: embeddingInput(c) })),
  }));
}

async function main() {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string", multiple: true },
      embedding: { type: "string" },
      reranker: { type: "string" },
      /** "synthetic" (8.7, the default) or "realistic" (8.9). */
      set: { type: "string", default: "synthetic" },
      /** A chat model id: rewrite realistic follow-ups with ADR-055's prompt before searching them. */
      "rewrite-model": { type: "string" },
      output: { type: "string" },
    },
  });
  for (const path of values["env-file"] ?? []) loadEnvFile(resolve(path));
  const set = values.set === "realistic" ? "realistic" : values.set === "synthetic" ? "synthetic" : undefined;
  if (!set) throw new AppError("validation_failed");
  const rewriteModel = values["rewrite-model"] ? registry.get(values["rewrite-model"]) : undefined;
  if (rewriteModel && (set !== "realistic" || rewriteModel.kind !== "chat")) throw new AppError("validation_failed");
  const defaultOutput =
    set === "synthetic"
      ? "packages/retrieval/evals/reports/baseline.json"
      : `packages/retrieval/evals/reports/realistic-${rewriteModel ? "rewritten" : "as-asked"}.json`;
  const embedding = values.embedding
    ? registry.get(values.embedding)
    : registry.models().find((m) => m.kind === "embedding");
  const reranker = values.reranker
    ? registry.get(values.reranker)
    : registry.models().find((m) => m.kind === "rerank" && m.provider === "tei");
  if (
    embedding?.kind !== "embedding" ||
    embedding.provider !== "openai" ||
    reranker?.kind !== "rerank" ||
    reranker.provider !== "tei"
  )
    throw new AppError("model_not_configured");
  const openai = process.env["OPENAI_API_KEY"];
  const tei = process.env["TEI_API_KEY"];
  const baseURL = process.env["TEI_BASE_URL"];
  if (!openai || !tei || !baseURL) throw new AppError("model_key_missing", { provider: "OpenAI and TEI" });
  const endpoint = new URL(baseURL);
  // CI publishes its disposable TEI container only on the runner's loopback interface.
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"))
    throw new AppError("validation_failed");
  const usage: UsageEvent[] = [];
  // The eval operator selects this authenticated server. Only authored synthetic fixtures reach it.
  const llm = createLlm({
    credentials: {
      workspaceKey: async (_ws, p) =>
        p === "openai" ? { apiKey: openai } : p === "tei" ? { apiKey: tei, baseURL } : undefined,
      platformKey: async () => undefined,
      platformKeysAllowed: async () => false,
    },
    onUsage: async (event) => void usage.push(event),
    rerankFetch: async (request) => {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      return { status: response.status, body: response.ok ? await response.json() : null };
    },
  });
  const pg = await startTestDatabase();
  const db = createDatabase({ url: pg.urls.rw, maxConnections: 4 });
  try {
    const ownerUserId = newId("usr");
    await superuserQuery(pg.urls, "insert into users (id, email, name) values ($1, $2, 'Eval runner')", [
      ownerUserId,
      `${ownerUserId}@example.test`,
    ]);
    const { workspace } = await createWorkspace(db, {
      ownerUserId,
      name: "Golden retrieval",
      slug: "golden-retrieval",
    });
    const ws = workspace.id;
    const documents = fixtureDocuments(set);
    const fixture = await db.withWorkspace(ws, async (tx) => {
      const bot = await createBot(tx, { name: "دليل أكاديمية السراج", slug: "golden", createdBy: ownerUserId });
      const kb = await createKnowledgeBase(tx, { botId: bot.id, name: "دليل افتراضي", embeddingModel: embedding.id });
      const source = await createSource(tx, { kbId: kb.id, kind: "text", config: {} });
      const ids: string[] = [];
      for (const doc of documents) {
        const row = await upsertDocument(tx, { kbId: kb.id, sourceId: source.id, uri: doc.uri, title: doc.title });
        ids.push(row.id);
      }
      return { bot, kb, ids };
    });
    const { bot, kb, ids } = fixture;
    const context = { workspaceId: ws, botId: bot.id, mode: "eval" as const };
    const embed = async (values: string[], purpose: string) =>
      (await llm.embed({ model: embedding.id, values, purpose, context })).embeddings;
    const inputs = documents.flatMap((doc) => doc.items.map((item) => item.input));
    const vectors = await embedAll((texts) => embed(texts, "kb_index"), inputs);
    let next = 0;
    await db.withWorkspace(ws, async (tx) => {
      for (const [d, doc] of documents.entries()) {
        const documentId = ids[d];
        if (!documentId) throw new Error("Missing fixture document");
        await updateDocument(tx, documentId, { status: "ready", lang: "ar" });
        await replaceChunks(tx, {
          kbId: kb.id,
          documentId,
          indexVersion: 1,
          rows: doc.items.map((item, ordinal) => {
            const vector = vectors[next++];
            if (!vector) throw new Error("Missing fixture vector");
            return {
              ordinal,
              headingPath: item.headingPath,
              text: item.text,
              textNorm: normalizeArabic(item.input),
              lexTokens: lexicalTokens(item.input).join(" "),
              tokenCount: lexicalTokens(item.input).length,
              embedding: vector,
              meta: { goldenKey: item.key },
            };
          }),
        });
      }
    });
    const retrieve = async (query: string) => {
      let trace: RetrievalTrace | undefined;
      const keys = new Map<string, string>();
      const search = createSearch({
        resolve: (ids) => db.withWorkspace(ws, (tx) => resolveSearchBases(tx, bot.id, ids)),
        embed: async (_model, text) => {
          const [v] = await embed([text], "kb_query");
          if (!v) throw new AppError("model_unavailable", { model: embedding.id });
          return v;
        },
        candidates: async (input) => {
          const found = await db.withWorkspace(ws, (tx) => searchCandidates(tx, bot.id, input));
          for (const row of [...found.dense, ...found.lexical]) {
            const key = row.meta["goldenKey"];
            if (typeof key === "string") keys.set(row.chunkId, key);
          }
          return found;
        },
        rerank: (text, candidates) =>
          llm.rerank({
            model: reranker.id,
            query: text,
            documents: candidates.map((c) => [...c.headingPath, c.text].join("\n")),
            purpose: "kb_rerank",
            context,
          }),
        trace: (record) => {
          trace = record;
        },
      });
      await search({ query, kbIds: [kb.id] });
      if (!trace) throw new Error("The production search returned no ranking trace");
      const asKeys = (rank: RetrievalTrace["dense"]) =>
        rank.map((item) => {
          const key = keys.get(item.chunkId);
          if (!key) throw new Error("A result did not match the synthetic corpus");
          return key;
        });
      return { dense: asKeys(trace.dense), hybrid: asKeys(trace.reranked) };
    };
    const onProgress = (done: number, total: number) => {
      if (done % 20 === 0) console.log(`Evaluated ${done}/${total}`);
    };
    // ADR-055's rewrite, with the production prompt: the opener and reply, then the follow-up.
    const rewrite = rewriteModel
      ? async (q: { query: string; history?: { user: string; assistant: string } }) => {
          const request = rewriteRequest(
            [
              { direction: "in", payload: { type: "text", text: q.history?.user ?? "" } },
              { direction: "out", payload: { type: "text", text: q.history?.assistant ?? "" } },
              { direction: "in", payload: { type: "text", text: q.query } },
            ],
            q.query,
          );
          const handle = llm.stream({ model: rewriteModel.id, ...request, maxOutputTokens: 4_096, context });
          for await (const _ of handle.textStream) {
            // The text is in `result` once the stream is read.
          }
          const text = (await handle.result).text.trim();
          return text === "" ? q.query : text;
        }
      : undefined;
    const report =
      set === "synthetic"
        ? await runRetrievalSuite({ retrieve, onProgress })
        : await runRealisticSuite({ retrieve, onProgress, ...(rewrite ? { rewrite } : {}) });
    const modelUsage = usage.reduce(
      (out, event) => ({
        calls: out.calls + 1,
        inputTokens: out.inputTokens + event.usage.inputTokens,
        rerankUnits: out.rerankUnits + (event.rerankUnits ?? 0),
        costMicroUsd: out.costMicroUsd + event.costMicroUsd,
      }),
      { calls: 0, inputTokens: 0, rerankUnits: 0, costMicroUsd: 0 },
    );
    const output = resolve(values.output ?? defaultOutput);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        {
          ...report,
          models: {
            embedding: embedding.id,
            reranker: reranker.id,
            ...(rewriteModel ? { rewrite: rewriteModel.id } : {}),
            rerankerRevision: process.env["TEI_MODEL_REVISION"] ?? null,
          },
          usage: modelUsage,
        },
        null,
        2,
      )}\n`,
    );
    const rows =
      "sets" in report
        ? report.sets.map((r) => ({ ...r, group: r.locale }))
        : report.slices.map((r) => ({ ...r, group: r.slice }));
    console.table(
      rows.map(({ group, count, dense, hybrid, passed }) => ({
        group,
        count,
        denseRecall: dense.recallAt5,
        hybridRecall: hybrid.recallAt5,
        denseMrr: dense.mrr,
        hybridMrr: hybrid.mrr,
        passed,
      })),
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    try {
      await db.close();
    } finally {
      await pg.stop();
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof AppError ? `${error.code}: ${error.title}` : "Retrieval evaluation failed before completion",
  );
  process.exitCode = 1;
});
