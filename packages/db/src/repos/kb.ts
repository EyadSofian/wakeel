import { AppError, newId } from "@wakeel/contracts";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { kbChunks, kbDocuments, kbIngestionJobs, kbSources, knowledgeBases } from "../schema/kb";
import { currentWorkspace } from "./scope";

/**
 * Knowledge bases, sources, documents, chunks and ingestion stage records (tasks 8.1, 8.4; ADR-041).
 * Every function runs inside `withWorkspace`; RLS decides what a call can see.
 */

export type KnowledgeBase = typeof knowledgeBases.$inferSelect;
export type KbSource = typeof kbSources.$inferSelect;
export type KbDocument = typeof kbDocuments.$inferSelect;
export type IngestionStage = "fetch" | "parse" | "normalise" | "chunk" | "embed" | "index";
export const INGESTION_STAGES: readonly IngestionStage[] = ["fetch", "parse", "normalise", "chunk", "embed", "index"];
/** Per-KB ingestion settings (ADR-041 §4): the vision model for the OCR tier and its page cap. */
export type KbSettings = { ocrModel?: string; maxOcrPages?: number };

const one = <T>(rows: T[]): T => {
  const [row] = rows;
  if (!row) throw new AppError("not_found");
  return row;
};

/** A unique violation on (bot_id, name) becomes a field error the Studio can show. */
const nameTaken = (e: unknown) => {
  let cur: unknown = e;
  while (cur instanceof Error && !("code" in cur) && cur.cause !== undefined) cur = cur.cause;
  if ((cur as { code?: string }).code === "23505")
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "name", code: "taken", message: "This bot already has a knowledge base with that name" }] },
    );
  throw e;
};

export async function createKnowledgeBase(
  tx: Tx,
  input: { botId: string; name: string; description?: string; embeddingModel: string; settings?: KbSettings },
): Promise<KnowledgeBase> {
  return one(
    await tx
      .insert(knowledgeBases)
      .values({
        id: newId("kb"),
        workspaceId: currentWorkspace,
        botId: input.botId,
        name: input.name,
        description: input.description ?? "",
        embeddingModel: input.embeddingModel,
        settings: input.settings ?? {},
      })
      .returning()
      .catch(nameTaken),
  );
}

export async function getKnowledgeBase(tx: Tx, kbId: string): Promise<KnowledgeBase> {
  return one(await tx.select().from(knowledgeBases).where(eq(knowledgeBases.id, kbId)));
}

export async function listKnowledgeBases(tx: Tx, botId: string): Promise<KnowledgeBase[]> {
  return tx.select().from(knowledgeBases).where(eq(knowledgeBases.botId, botId)).orderBy(asc(knowledgeBases.createdAt));
}

export async function updateKnowledgeBase(
  tx: Tx,
  kbId: string,
  patch: { name?: string; description?: string; settings?: KbSettings },
): Promise<KnowledgeBase> {
  return one(
    await tx
      .update(knowledgeBases)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(knowledgeBases.id, kbId))
      .returning()
      .catch(nameTaken),
  );
}

export async function deleteKnowledgeBase(tx: Tx, kbId: string): Promise<void> {
  one(await tx.delete(knowledgeBases).where(eq(knowledgeBases.id, kbId)).returning({ id: knowledgeBases.id }));
}

export async function createSource(
  tx: Tx,
  input: { kbId: string; kind: KbSource["kind"]; config: Record<string, unknown>; schedule?: string | null },
): Promise<KbSource> {
  await getKnowledgeBase(tx, input.kbId);
  return one(
    await tx
      .insert(kbSources)
      .values({
        id: newId("src"),
        workspaceId: currentWorkspace,
        kbId: input.kbId,
        kind: input.kind,
        config: input.config,
        schedule: input.schedule ?? null,
      })
      .returning(),
  );
}

export async function getSource(tx: Tx, sourceId: string): Promise<KbSource> {
  return one(await tx.select().from(kbSources).where(eq(kbSources.id, sourceId)));
}

export async function listSources(tx: Tx, kbId: string): Promise<KbSource[]> {
  return tx.select().from(kbSources).where(eq(kbSources.kbId, kbId)).orderBy(asc(kbSources.createdAt));
}

export async function updateSource(
  tx: Tx,
  sourceId: string,
  patch: Partial<Pick<KbSource, "status" | "lastSyncedAt" | "error" | "config" | "schedule">>,
): Promise<KbSource> {
  return one(
    await tx
      .update(kbSources)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(kbSources.id, sourceId))
      .returning(),
  );
}

export async function deleteSource(tx: Tx, sourceId: string): Promise<void> {
  one(await tx.delete(kbSources).where(eq(kbSources.id, sourceId)).returning({ id: kbSources.id }));
}

/** The document for a source's file or page; a re-sync of the same URI finds the same row. */
export async function upsertDocument(
  tx: Tx,
  input: { kbId: string; sourceId: string; uri: string; title?: string; mime?: string | null },
): Promise<KbDocument> {
  return one(
    await tx
      .insert(kbDocuments)
      .values({
        id: newId("doc"),
        workspaceId: currentWorkspace,
        kbId: input.kbId,
        sourceId: input.sourceId,
        uri: input.uri,
        title: input.title ?? "",
        mime: input.mime ?? null,
      })
      .onConflictDoUpdate({
        target: [kbDocuments.sourceId, kbDocuments.uri],
        set: { updatedAt: sql`now()`, ...(input.mime ? { mime: input.mime } : {}) },
      })
      .returning(),
  );
}

export async function getDocument(tx: Tx, documentId: string): Promise<KbDocument> {
  return one(await tx.select().from(kbDocuments).where(eq(kbDocuments.id, documentId)));
}

export async function listDocuments(tx: Tx, filter: { kbId?: string; sourceId?: string }): Promise<KbDocument[]> {
  const where = filter.sourceId ? eq(kbDocuments.sourceId, filter.sourceId) : eq(kbDocuments.kbId, filter.kbId ?? "");
  return tx.select().from(kbDocuments).where(where).orderBy(asc(kbDocuments.createdAt));
}

export async function updateDocument(
  tx: Tx,
  documentId: string,
  patch: Partial<
    Pick<KbDocument, "title" | "mime" | "lang" | "contentHash" | "parsedKey" | "status" | "tokenCount" | "meta">
  >,
): Promise<KbDocument> {
  return one(
    await tx
      .update(kbDocuments)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(kbDocuments.id, documentId))
      .returning(),
  );
}

export async function deleteDocument(tx: Tx, documentId: string): Promise<void> {
  one(await tx.delete(kbDocuments).where(eq(kbDocuments.id, documentId)).returning({ id: kbDocuments.id }));
}

export type StageRecord = typeof kbIngestionJobs.$inferSelect;

export async function getStages(tx: Tx, documentId: string): Promise<StageRecord[]> {
  return tx.select().from(kbIngestionJobs).where(eq(kbIngestionJobs.documentId, documentId));
}

/** Marks a stage running; attempts count every start, so a resumed stage shows its retries. */
export async function startStage(
  tx: Tx,
  input: { kbId: string; sourceId: string; documentId: string; stage: IngestionStage },
): Promise<void> {
  await tx
    .insert(kbIngestionJobs)
    .values({
      id: newId("ijob"),
      workspaceId: currentWorkspace,
      kbId: input.kbId,
      sourceId: input.sourceId,
      documentId: input.documentId,
      stage: input.stage,
      status: "running",
      attempts: 1,
      startedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [kbIngestionJobs.documentId, kbIngestionJobs.stage],
      set: {
        status: "running",
        attempts: sql`${kbIngestionJobs.attempts} + 1`,
        error: null,
        startedAt: sql`now()`,
        finishedAt: null,
        updatedAt: sql`now()`,
      },
    });
}

export async function finishStage(
  tx: Tx,
  documentId: string,
  stage: IngestionStage,
  contentHash: string,
): Promise<void> {
  await tx
    .update(kbIngestionJobs)
    .set({ status: "done", contentHash, error: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(kbIngestionJobs.documentId, documentId), eq(kbIngestionJobs.stage, stage)));
}

export async function failStage(
  tx: Tx,
  documentId: string,
  stage: IngestionStage,
  error: { code: string; title: string },
): Promise<void> {
  await tx
    .update(kbIngestionJobs)
    .set({ status: "failed", error, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(kbIngestionJobs.documentId, documentId), eq(kbIngestionJobs.stage, stage)));
}

/**
 * Replaces a document's chunks for one index version in one statement batch. Old chunks of the same
 * version go first, so a re-index never leaves two copies; other versions are untouched (§8.1: a
 * model change re-embeds in the background while search keeps using the old version).
 */
export async function replaceChunks(
  tx: Tx,
  input: {
    kbId: string;
    documentId: string;
    indexVersion: number;
    rows: {
      ordinal: number;
      headingPath: string[];
      text: string;
      textNorm: string;
      lexTokens: string;
      embedding: number[];
      tokenCount: number;
      meta: Record<string, unknown>;
    }[];
  },
): Promise<void> {
  await tx
    .delete(kbChunks)
    .where(and(eq(kbChunks.documentId, input.documentId), eq(kbChunks.indexVersion, input.indexVersion)));
  for (let i = 0; i < input.rows.length; i += 200) {
    await tx.insert(kbChunks).values(
      input.rows.slice(i, i + 200).map((r) => ({
        id: newId("chk"),
        workspaceId: currentWorkspace,
        kbId: input.kbId,
        documentId: input.documentId,
        ordinal: r.ordinal,
        headingPath: r.headingPath,
        text: r.text,
        textNorm: r.textNorm,
        lex: sql`to_tsvector('simple', ${r.lexTokens})`,
        embedding: r.embedding,
        tokenCount: r.tokenCount,
        meta: r.meta,
        indexVersion: input.indexVersion,
      })),
    );
  }
}

export async function countChunks(tx: Tx, documentId: string, indexVersion: number): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(kbChunks)
    .where(and(eq(kbChunks.documentId, documentId), eq(kbChunks.indexVersion, indexVersion)));
  return row?.n ?? 0;
}
