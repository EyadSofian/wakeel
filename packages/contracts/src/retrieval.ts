import { z } from "zod";
import { ChunkId, DocumentId, IsoDateTime, Json, KbSourceId, KnowledgeBaseId, ModelRef } from "./common";
import type { BotMessagePayload } from "./message";
import { Citation } from "./message";

/** ADR-043: every populated filter applies to both retrieval legs. */
export const SearchFilters = z.strictObject({
  documentIds: z.array(DocumentId).min(1).max(200).optional(),
  sourceIds: z.array(KbSourceId).min(1).max(200).optional(),
  languages: z.array(z.string().min(1).max(35)).min(1).max(20).optional(),
});
export type SearchFilters = z.infer<typeof SearchFilters>;

export const SearchRequest = z.strictObject({
  query: z.string().trim().min(1).max(8000),
  kbIds: z.array(KnowledgeBaseId).min(1).max(20),
  topK: z.number().int().min(1).max(20).default(5),
  filters: SearchFilters.optional(),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

/** Parsed on both reads and writes of knowledge_bases.settings. */
export const KbSettings = z.object({
  ocrModel: ModelRef.optional(),
  maxOcrPages: z.number().int().min(1).max(500).optional(),
  minScore: z.number().finite().optional(),
});
export type KbSettings = z.infer<typeof KbSettings>;

export const CitationSource = Citation.omit({ index: true });
export type CitationSource = z.infer<typeof CitationSource>;

/** Committed with the step and reset only when a new turn begins, so retries preserve citations. */
export const SearchCitations = z.object({
  next: z.number().int().positive().default(1),
  sources: z.record(z.string().regex(/^c[1-9]\d*$/), CitationSource).default({}),
});
export type SearchCitations = z.infer<typeof SearchCitations>;

/** Internal candidate row shared by the database adapter and pure retrieval pipeline. */
export const SearchCandidate = z.object({
  chunkId: ChunkId,
  documentId: DocumentId,
  kbId: KnowledgeBaseId,
  sourceId: KbSourceId,
  language: z.string().nullable(),
  title: z.string(),
  uri: z.string(),
  headingPath: z.array(z.string()),
  text: z.string(),
  score: z.number().finite(),
  meta: z.record(z.string(), Json).default({}),
});
export type SearchCandidate = z.infer<typeof SearchCandidate>;

const RankedCandidate = z.object({ chunkId: ChunkId, score: z.number().finite() });
export const SearchTrace = z.object({
  query: z.string(),
  queryNormalised: z.string(),
  kbIds: z.array(KnowledgeBaseId),
  dense: z.array(RankedCandidate),
  lexical: z.array(RankedCandidate),
  fused: z.array(RankedCandidate),
  reranked: z.array(RankedCandidate),
  returned: z.number().int().nonnegative(),
});
export type SearchTrace = z.infer<typeof SearchTrace>;
export const RetrievalRecord = SearchTrace.extend({
  startedAt: IsoDateTime,
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export type RetrievalRecord = z.infer<typeof RetrievalRecord>;

/** Maps only registered labels, strips unknown labels, and numbers citations by first use. */
export function mapCitations(
  text: string,
  sources: Readonly<Record<string, CitationSource>>,
): { text: string; citations: z.infer<typeof Citation>[] } {
  const citations: z.infer<typeof Citation>[] = [];
  const seen = new Set<string>();
  const stripped = text.replace(/\s*\[\[(c\d+)\]\]/g, (_match, token: string) => {
    const source = sources[token];
    if (source && !seen.has(token)) {
      seen.add(token);
      citations.push({ ...source, index: citations.length + 1 });
    }
    return "";
  });
  return { text: stripped, citations };
}

/** Resolves outgoing text/caption citations at the persistence boundary, using the committed registry. */
export function mapPayloadCitations(payload: BotMessagePayload, sources: Readonly<Record<string, CitationSource>>) {
  if (payload.type === "text" || payload.type === "choice" || payload.type === "dropdown") {
    const mapped = mapCitations(payload.text, sources);
    return { payload: { ...payload, text: mapped.text }, citations: mapped.citations };
  }
  if (payload.type === "image" && payload.caption) {
    const mapped = mapCitations(payload.caption, sources);
    return { payload: { ...payload, caption: mapped.text }, citations: mapped.citations };
  }
  return { payload, citations: [] };
}
