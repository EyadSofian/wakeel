import { z } from "zod";
import { Passage } from "./card";
import { BotId, ChunkId, DocumentId, IsoDateTime, KbSourceId, KnowledgeBaseId, ModelRef } from "./common";
import { KbSourceConfig, KbSyncSchedule } from "./platform";
import { KbSettings, RetrievalRecord, SearchRequest } from "./retrieval";

export const NewKnowledgeBase = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).optional(),
  embeddingModel: ModelRef,
  settings: KbSettings.optional(),
});
export const PatchKnowledgeBase = NewKnowledgeBase.omit({ embeddingModel: true }).partial();
export const KnowledgeSummary = NewKnowledgeBase.extend({
  id: KnowledgeBaseId,
  botId: BotId,
  description: z.string(),
  settings: KbSettings,
  revision: z.string(),
});
export type KnowledgeSummary = z.infer<typeof KnowledgeSummary>;
export const NewKnowledgeSource = z.strictObject({ source: KbSourceConfig, schedule: KbSyncSchedule.optional() });
export const KnowledgeSourceSummary = z.object({
  id: KbSourceId,
  label: z.string(),
  kind: z.string(),
  status: z.string(),
  lastSyncedAt: IsoDateTime.nullable(),
  revision: z.string(),
  documents: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  stages: z.array(
    z.object({ stage: z.string(), done: z.number().int().nonnegative(), running: z.number().int().nonnegative() }),
  ),
});
export type KnowledgeSourceSummary = z.infer<typeof KnowledgeSourceSummary>;
export const KnowledgeDocumentSummary = z.object({
  id: DocumentId,
  title: z.string(),
  status: z.string(),
  language: z.string().nullable(),
  tokenCount: z.number().int().nonnegative(),
  quality: z.number().nullable(),
});
export type KnowledgeDocumentSummary = z.infer<typeof KnowledgeDocumentSummary>;
export const KnowledgeDocumentDetail = KnowledgeDocumentSummary.extend({ markdown: z.string().nullable() });
export const KnowledgeChunk = z.object({
  id: ChunkId,
  ordinal: z.number().int().nonnegative(),
  text: z.string(),
  headingPath: z.array(z.string()),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunk>;
export const TestKnowledgeSearch = SearchRequest.omit({ kbIds: true });
export const TestKnowledgeResult = z.object({ passages: z.array(Passage), trace: RetrievalRecord });
export type TestKnowledgeResult = z.infer<typeof TestKnowledgeResult>;
