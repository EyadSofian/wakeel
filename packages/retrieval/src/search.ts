import {
  AppError,
  SearchCandidate as CandidateSchema,
  CitationSource,
  FIELD_ERRORS,
  type Passage,
  type SearchCandidate,
  SearchCitations,
  type SearchFilters,
  SearchRequest,
} from "@wakeel/contracts";
import { queryTokens } from "./arabic";
import { fitVector } from "./embed";

export type { SearchCandidate } from "@wakeel/contracts";

export interface SearchPorts {
  /** Resolves every requested KB under the workspace and bot boundary, or fails the request. */
  resolve(
    kbIds: readonly string[],
  ): Promise<{ id: string; embeddingModel: string; indexVersion: number; minScore?: number }[]>;
  embed(model: string, query: string): Promise<number[]>;
  candidates(input: {
    kbIds: string[];
    vector: number[];
    tokens: string[];
    filters?: SearchFilters;
  }): Promise<{ dense: SearchCandidate[]; lexical: SearchCandidate[] }>;
  rerank(query: string, candidates: readonly SearchCandidate[]): Promise<{ index: number; score: number }[]>;
  trace?(attrs: RetrievalTrace): void;
}

export interface RetrievalTrace {
  query: string;
  queryNormalised: string;
  kbIds: string[];
  dense: { chunkId: string; score: number }[];
  lexical: { chunkId: string; score: number }[];
  fused: { chunkId: string; score: number }[];
  reranked: { chunkId: string; score: number }[];
  returned: number;
}

/** Architecture §8.2: one-based ranks, k=60, each chunk contributes at most once per leg. */
export function reciprocalRankFusion(
  dense: readonly SearchCandidate[],
  lexical: readonly SearchCandidate[],
): SearchCandidate[] {
  const merged = new Map<string, SearchCandidate>();
  for (const leg of [dense, lexical]) {
    const seen = new Set<string>();
    for (const [index, row] of leg.entries()) {
      if (seen.has(row.chunkId)) continue;
      seen.add(row.chunkId);
      const previous = merged.get(row.chunkId);
      merged.set(row.chunkId, { ...row, score: (previous?.score ?? 0) + 1 / (60 + index + 1) });
    }
  }
  return [...merged.values()].sort(compare);
}

function compare(a: SearchCandidate, b: SearchCandidate): number {
  return b.score - a.score || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0);
}

const ranks = (rows: readonly SearchCandidate[]) => rows.map(({ chunkId, score }) => ({ chunkId, score }));

/** The shared hybrid pipeline. All I/O is supplied by adapters; no dense-only failure fallback. */
export function createSearch(ports: SearchPorts) {
  return async (
    raw: unknown,
    previous?: SearchCitations,
  ): Promise<{ passages: Passage[]; citations: SearchCitations }> => {
    const request = SearchRequest.parse(raw);
    const kbIds = [...new Set(request.kbIds)];
    const resolved = await ports.resolve(kbIds);
    if (resolved.length !== kbIds.length || kbIds.some((id) => !resolved.some((kb) => kb.id === id)))
      throw new AppError("not_found");
    const model = resolved[0]?.embeddingModel;
    if (!model) throw new AppError("model_not_configured");
    if (resolved.some((kb) => kb.embeddingModel !== model))
      throw new AppError(
        "validation_failed",
        {},
        { errors: [{ path: "kbIds", code: "mixed_embedding_models", message: FIELD_ERRORS.mixedEmbeddingModels }] },
      );
    const tokens = queryTokens(request.query);
    const vector = fitVector(await ports.embed(model, request.query));
    const candidates = await ports.candidates({
      kbIds,
      vector,
      tokens,
      ...(request.filters ? { filters: request.filters } : {}),
    });
    const checked = (rows: SearchCandidate[]) =>
      rows
        .slice(0, 30)
        .map((row) => CandidateSchema.parse(row))
        .filter((row) => kbIds.includes(row.kbId));
    const dense = checked(candidates.dense),
      lexical = checked(candidates.lexical);
    const fused = reciprocalRankFusion(dense, lexical).slice(0, 30);
    ports.trace?.({
      query: request.query,
      queryNormalised: tokens.join(" "),
      kbIds,
      dense: ranks(dense),
      lexical: ranks(lexical),
      fused: ranks(fused),
      reranked: [],
      returned: 0,
    });
    const ranked: SearchCandidate[] = [];
    if (fused.length) {
      const seen = new Set<number>();
      for (const row of await ports.rerank(request.query, fused)) {
        const candidate = fused[row.index];
        if (!Number.isInteger(row.index) || !candidate || seen.has(row.index) || !Number.isFinite(row.score))
          throw new AppError("model_unavailable");
        seen.add(row.index);
        ranked.push({ ...candidate, score: row.score });
      }
      if (seen.size !== fused.length) throw new AppError("model_unavailable");
    }
    ranked.sort(compare);
    const selected = ranked
      .filter((row) => {
        const floor = resolved.find((kb) => kb.id === row.kbId)?.minScore;
        return floor === undefined || row.score >= floor;
      })
      .slice(0, request.topK);
    const citations = structuredClone(SearchCitations.parse(previous ?? {}));
    const passages: Passage[] = selected.map((row) => {
      const label = `c${citations.next++}`;
      citations.sources[label] = CitationSource.parse({
        documentId: row.documentId,
        chunkId: row.chunkId,
        title: row.title,
        ...(row.uri ? { uri: row.uri } : {}),
        snippet: row.text.slice(0, 500),
      });
      return {
        chunkId: row.chunkId,
        documentId: row.documentId,
        title: row.title,
        ...(row.uri ? { uri: row.uri } : {}),
        headingPath: row.headingPath,
        text: row.text,
        score: row.score,
        cite: `[[${label}]]`,
        meta: row.meta,
      };
    });
    ports.trace?.({
      query: request.query,
      queryNormalised: tokens.join(" "),
      kbIds,
      dense: ranks(dense),
      lexical: ranks(lexical),
      fused: ranks(fused),
      reranked: ranks(ranked),
      returned: passages.length,
    });
    return { passages, citations };
  };
}
