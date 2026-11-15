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
import { corpus } from "../packages/retrieval/evals/corpus";
import { runRetrievalSuite } from "../packages/retrieval/evals/runner";

async function main() {
  const { values } = parseArgs({
    options: {
      "env-file": { type: "string", multiple: true },
      embedding: { type: "string" },
      reranker: { type: "string" },
      output: { type: "string", default: "packages/retrieval/evals/reports/baseline.json" },
    },
  });
  for (const path of values["env-file"] ?? []) loadEnvFile(resolve(path));
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
  if (new URL(baseURL).protocol !== "https:") throw new AppError("validation_failed");
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
    const fixture = await db.withWorkspace(ws, async (tx) => {
      const bot = await createBot(tx, { name: "دليل أكاديمية السراج", slug: "golden", createdBy: ownerUserId });
      const kb = await createKnowledgeBase(tx, { botId: bot.id, name: "دليل افتراضي", embeddingModel: embedding.id });
      const source = await createSource(tx, { kbId: kb.id, kind: "text", config: {} });
      const document = await upsertDocument(tx, {
        kbId: kb.id,
        sourceId: source.id,
        uri: "https://example.test/golden",
        title: "دليل أكاديمية السراج",
      });
      return { bot, kb, document };
    });
    const { bot, kb, document } = fixture;
    const context = { workspaceId: ws, botId: bot.id, mode: "eval" as const };
    const embed = async (values: string[], purpose: string) =>
      (await llm.embed({ model: embedding.id, values, purpose, context })).embeddings;
    const inputs = corpus.map((item) => [...item.headingPath, item.text].join("\n"));
    const vectors = await embedAll((texts) => embed(texts, "kb_index"), inputs);
    await db.withWorkspace(ws, async (tx) => {
      await updateDocument(tx, document.id, { status: "ready", lang: "ar" });
      await replaceChunks(tx, {
        kbId: kb.id,
        documentId: document.id,
        indexVersion: 1,
        rows: corpus.map((item, ordinal) => {
          const vector = vectors[ordinal];
          if (!vector) throw new Error("Missing fixture vector");
          const input = inputs[ordinal] ?? item.text;
          return {
            ordinal,
            headingPath: item.headingPath,
            text: item.text,
            textNorm: normalizeArabic(input),
            lexTokens: lexicalTokens(input).join(" "),
            tokenCount: lexicalTokens(input).length,
            embedding: vector,
            meta: { goldenKey: item.key },
          };
        }),
      });
    });
    const report = await runRetrievalSuite({
      retrieve: async (query) => {
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
      },
      onProgress: (done, total) => {
        if (done % 20 === 0) console.log(`Evaluated ${done}/${total}`);
      },
    });
    const modelUsage = usage.reduce(
      (out, event) => ({
        calls: out.calls + 1,
        inputTokens: out.inputTokens + event.usage.inputTokens,
        rerankUnits: out.rerankUnits + (event.rerankUnits ?? 0),
        costMicroUsd: out.costMicroUsd + event.costMicroUsd,
      }),
      { calls: 0, inputTokens: 0, rerankUnits: 0, costMicroUsd: 0 },
    );
    const output = resolve(values.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(
        {
          ...report,
          models: {
            embedding: embedding.id,
            reranker: reranker.id,
            rerankerRevision: process.env["TEI_MODEL_REVISION"] ?? null,
          },
          usage: modelUsage,
        },
        null,
        2,
      )}\n`,
    );
    console.table(
      report.sets.map(({ locale, count, dense, hybrid, passed }) => ({
        locale,
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
