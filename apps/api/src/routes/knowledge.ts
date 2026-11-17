import { createHash } from "node:crypto";
import {
  AppError,
  BotId,
  ChunkId,
  DocumentId,
  KbSourceConfig,
  KbSourceId,
  KnowledgeBaseId,
  KnowledgeChunk,
  KnowledgeDocumentDetail,
  KnowledgeDocumentSummary,
  KnowledgeSourceSummary,
  KnowledgeSummary,
  NewKnowledgeBase,
  NewKnowledgeSource,
  PatchKnowledgeBase,
  type RetrievalRecord,
  TestKnowledgeResult,
  TestKnowledgeSearch,
} from "@wakeel/contracts";
import {
  createKnowledgeBase,
  createSource,
  deleteKnowledgeBase,
  deleteSource,
  getBot,
  getDocument,
  getFile,
  getKnowledgeBase,
  getSource,
  getVersion,
  type KbDocument,
  type KbSource,
  type KnowledgeBase,
  sql,
  type Tx,
  updateKnowledgeBase,
} from "@wakeel/db";
import { type LlmClient, registry } from "@wakeel/llm";
import { turnKnowledge } from "@wakeel/retrieval/service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireMember, type StudioDeps } from "../studio";

export interface KnowledgeDeps {
  llm: Pick<LlmClient, "embed" | "rerank">;
  enqueueSync(job: { workspaceId: string; sourceId: string }): Promise<void>;
}

const params = z.object({
  botId: BotId,
  kbId: KnowledgeBaseId.optional(),
  sourceId: KbSourceId.optional(),
  documentId: DocumentId.optional(),
});
const queryPage = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
const revision = (data: unknown) => `"${createHash("sha256").update(JSON.stringify(data)).digest("base64url")}"`;
const parseParams = (r: FastifyRequest) => {
  const result = params.safeParse(r.params);
  if (!result.success) throw new AppError("not_found");
  return result.data;
};
const required = (id: string | undefined) => {
  if (!id) throw new AppError("not_found");
  return id;
};
function match(request: FastifyRequest, current: string) {
  if (!request.headers["if-match"])
    throw new AppError("validation_failed", {}, { detail: "Send the current revision in If-Match." });
  if (request.headers["if-match"] !== current) throw new AppError("revision_conflict");
}
function page<T extends { id: string }>(items: T[], limit: number) {
  const data = items.slice(0, limit);
  return { data, nextCursor: items.length > limit ? (data.at(-1)?.id ?? null) : null };
}
function pagination(r: FastifyRequest, cursorType: z.ZodType<string>) {
  const { limit, cursor } = queryPage.parse(r.query);
  return { limit, cursor: cursor === undefined ? "" : cursorType.parse(cursor) };
}
const summary = (b: KnowledgeBase) =>
  KnowledgeSummary.parse({
    id: b.id,
    botId: b.botId,
    name: b.name,
    description: b.description,
    settings: b.settings,
    embeddingModel: b.embeddingModel,
    revision: revision([b.id, b.name, b.description, b.settings, b.updatedAt]),
  });
const documentSummary = (d: KbDocument) => {
  const quality = z.object({ quality: z.object({ score: z.number() }) }).safeParse(d.meta);
  return KnowledgeDocumentSummary.parse({
    id: d.id,
    title: d.title,
    status: d.status,
    language: d.lang,
    tokenCount: d.tokenCount,
    quality: quality.success ? quality.data.quality.score : null,
  });
};
const sourceRevision = (s: KbSource) => revision([s.id, s.kind, s.config, s.schedule]);
async function sourceSummary(tx: Tx, s: KbSource) {
  const c = KbSourceConfig.parse({ kind: s.kind, ...(s.config as object) });
  const label = c.kind === "file" ? (await getFile(tx, c.fileId)).name : c.kind === "text" ? c.title : c.url;
  const counts = await tx.execute(sql`select count(*)::int as documents,
    count(*) filter(where status='ready')::int as ready from kb_documents where source_id=${s.id}`);
  const stages = await tx.execute(sql`select stage, count(*) filter(where status='done')::int as done,
    count(*) filter(where status='running')::int as running from kb_ingestion_jobs where source_id=${s.id} group by stage order by stage`);
  return KnowledgeSourceSummary.parse({
    id: s.id,
    label,
    kind: c.kind,
    status: s.status,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    revision: sourceRevision(s),
    ...counts.rows[0],
    stages: stages.rows,
  });
}

export async function knowledgeRoutes(
  app: FastifyInstance,
  { studio, knowledge }: { studio: StudioDeps; knowledge?: KnowledgeDeps },
) {
  const root = "/v1/workspaces/:workspaceId/bots/:botId/knowledge-bases";
  const item = `${root}/:kbId`;
  async function scoped<T>(
    r: FastifyRequest,
    reply: FastifyReply,
    w: boolean,
    action: (tx: Tx, p: ReturnType<typeof parseParams>, ws: string) => Promise<T>,
  ) {
    const actor = await requireMember(studio, r, reply, w ? "bot.update" : "bot.read");
    const p = parseParams(r);
    return studio.db.withWorkspace(actor.workspaceId, async (tx) => {
      await getBot(tx, p.botId);
      return action(tx, p, actor.workspaceId);
    });
  }
  async function kb(tx: Tx, p: ReturnType<typeof parseParams>, lock = false) {
    const id = required(p.kbId);
    const found = await tx.execute(
      sql`select id from knowledge_bases where id=${id} and bot_id=${p.botId} ${lock ? sql`for update` : sql``}`,
    );
    if (!found.rows.length) throw new AppError("not_found");
    return getKnowledgeBase(tx, id);
  }
  async function source(tx: Tx, p: ReturnType<typeof parseParams>) {
    const b = await kb(tx, p);
    const s = await getSource(tx, required(p.sourceId));
    if (s.kbId !== b.id) throw new AppError("not_found");
    return s;
  }
  function queue() {
    if (!knowledge) throw new AppError("internal_error");
    return knowledge.enqueueSync;
  }

  app.get(root, (r, reply) =>
    scoped(r, reply, false, async (tx, p) => {
      const q = pagination(r, KnowledgeBaseId);
      const results = await tx.execute(sql`select id from knowledge_bases where bot_id=${p.botId} and id>${q.cursor}
      order by id limit ${q.limit + 1}`);
      return page(
        await Promise.all(
          results.rows.map(async (row) => summary(await getKnowledgeBase(tx, KnowledgeBaseId.parse(row["id"])))),
        ),
        q.limit,
      );
    }),
  );
  // Every handler sends after `scoped` returns, that is after the transaction commits. Sending from
  // inside it let a client act on a 201 before the row existed for its next request.
  app.post(root, async (r, reply) => {
    const b = await scoped(r, reply, true, async (tx, p) => {
      const body = NewKnowledgeBase.parse(r.body);
      const model = registry.get(body.embeddingModel.split(":").slice(1).join(":"));
      if (model.kind !== "embedding" || !body.embeddingModel.startsWith(`${model.provider}:`))
        throw new AppError("validation_failed");
      return summary(await createKnowledgeBase(tx, { ...body, botId: p.botId }));
    });
    return reply.code(201).header("etag", b.revision).send(b);
  });
  app.get(item, async (r, reply) => {
    const b = await scoped(r, reply, false, async (tx, p) => summary(await kb(tx, p)));
    return reply.header("etag", b.revision).send(b);
  });
  app.patch(item, async (r, reply) => {
    const b = await scoped(r, reply, true, async (tx, p) => {
      const current = await kb(tx, p, true);
      match(r, summary(current).revision);
      return summary(await updateKnowledgeBase(tx, current.id, PatchKnowledgeBase.parse(r.body)));
    });
    return reply.header("etag", b.revision).send(b);
  });
  app.delete(item, async (r, reply) => {
    await scoped(r, reply, true, async (tx, p) => {
      await tx.execute(sql`select id from bots where id=${p.botId} for update`);
      const bot = await getBot(tx, p.botId);
      const current = await kb(tx, p, true);
      match(r, summary(current).revision);
      if (bot.publishedVersionId) {
        const { definition } = await getVersion(tx, bot.id, bot.publishedVersionId);
        const uses = definition.workflows.flatMap((w) =>
          w.nodes.flatMap((n) => {
            const refs = n.type === "autonomous" ? n.tools : "cards" in n ? n.cards : [];
            return refs.some((c) => c.type === "kb_search" && c.kbIds.includes(current.id))
              ? [`${w.name} / ${n.name}`]
              : [];
          }),
        );
        if (uses.length) throw new AppError("resource_in_use", { usages: uses.join(", ") });
      }
      await deleteKnowledgeBase(tx, current.id);
    });
    return reply.code(204).send();
  });
  app.get(`${item}/sources`, (r, reply) =>
    scoped(r, reply, false, async (tx, p) => {
      const b = await kb(tx, p);
      const q = pagination(r, KbSourceId);
      const results = await tx.execute(
        sql`select id from kb_sources where kb_id=${b.id} and id>${q.cursor} order by id limit ${q.limit + 1}`,
      );
      return page(
        await Promise.all(
          results.rows.map(async (row) => sourceSummary(tx, await getSource(tx, KbSourceId.parse(row["id"])))),
        ),
        q.limit,
      );
    }),
  );
  app.post(`${item}/sources`, async (r, reply) => {
    const enqueue = queue();
    const ready = await scoped(r, reply, true, async (tx, p, workspaceId) => {
      const b = await kb(tx, p, true);
      const { source: config, schedule } = NewKnowledgeSource.parse(r.body);
      if (schedule && (config.kind === "file" || config.kind === "text")) throw new AppError("validation_failed");
      if (config.kind === "file") {
        const f = await getFile(tx, config.fileId);
        if (f.botId !== b.botId || f.purpose !== "kb_source") throw new AppError("not_found");
        if (f.status !== "ready") throw new AppError("upload_incomplete");
      }
      const { kind, ...data } = config;
      const s = await createSource(tx, { kbId: b.id, kind, config: data, schedule: schedule ?? null });
      return { workspaceId, data: await sourceSummary(tx, s) };
    });
    await enqueue({ workspaceId: ready.workspaceId, sourceId: ready.data.id });
    return reply.code(201).header("etag", ready.data.revision).send(ready.data);
  });
  app.post(`${item}/sources/:sourceId/sync`, async (r, reply) => {
    const job = await scoped(r, reply, true, async (tx, p, workspaceId) => {
      const s = await source(tx, p);
      return { workspaceId, sourceId: s.id };
    });
    await queue()(job);
    return reply.code(202).send({ accepted: true });
  });
  app.delete(`${item}/sources/:sourceId`, async (r, reply) => {
    await scoped(r, reply, true, async (tx, p) => {
      await kb(tx, p, true);
      const s = await source(tx, p);
      match(r, sourceRevision(s));
      await deleteSource(tx, s.id);
    });
    return reply.code(204).send();
  });
  app.get(`${item}/documents`, (r, reply) =>
    scoped(r, reply, false, async (tx, p) => {
      const b = await kb(tx, p);
      const q = pagination(r, DocumentId);
      const results = await tx.execute(
        sql`select id from kb_documents where kb_id=${b.id} and id>${q.cursor} order by id limit ${q.limit + 1}`,
      );
      return page(
        await Promise.all(
          results.rows.map(async (row) => documentSummary(await getDocument(tx, DocumentId.parse(row["id"])))),
        ),
        q.limit,
      );
    }),
  );
  async function document(tx: Tx, p: ReturnType<typeof parseParams>) {
    const b = await kb(tx, p);
    const doc = await getDocument(tx, required(p.documentId));
    if (doc.kbId !== b.id) throw new AppError("not_found");
    return { b, doc };
  }
  app.get(`${item}/documents/:documentId`, async (r, reply) => {
    const { doc } = await scoped(r, reply, false, document);
    return KnowledgeDocumentDetail.parse({
      ...documentSummary(doc),
      markdown: doc.parsedKey ? new TextDecoder().decode(await studio.objectStore.get(doc.parsedKey)) : null,
    });
  });
  app.get(`${item}/documents/:documentId/chunks`, (r, reply) =>
    scoped(r, reply, false, async (tx, p) => {
      const { b, doc } = await document(tx, p);
      const q = pagination(r, ChunkId);
      const result = await tx.execute(sql`select id, ordinal, text, heading_path as "headingPath" from kb_chunks
      where document_id=${doc.id} and kb_id=${b.id} and index_version=${b.indexVersion}
      and (${q.cursor}='' or (ordinal,id) > (select ordinal,id from kb_chunks where id=${q.cursor} and document_id=${doc.id} and kb_id=${b.id} and index_version=${b.indexVersion}))
      order by ordinal,id limit ${q.limit + 1}`);
      return page(
        result.rows.map((row) => KnowledgeChunk.parse(row)),
        q.limit,
      );
    }),
  );
  app.post(`${item}/test-search`, async (r, reply) => {
    if (!knowledge) throw new AppError("model_not_configured");
    const { b, workspaceId } = await scoped(r, reply, false, async (tx, p, workspaceId) => ({
      b: await kb(tx, p),
      workspaceId,
    }));
    let trace: RetrievalRecord | undefined;
    const search = turnKnowledge(
      { db: studio.db, llm: knowledge.llm },
      { workspaceId, botId: b.botId, mode: "emulator" },
      (r) => {
        trace = r;
      },
    );
    const { passages } = await search.search({ ...TestKnowledgeSearch.parse(r.body), kbIds: [b.id] });
    return TestKnowledgeResult.parse({ passages, trace });
  });
}
