import { indexTokens, normalizeArabic } from "./arabic";
import { type Chunk, embeddingInput } from "./chunk";

/**
 * What the indexer writes per chunk (architecture §8.1 "Index", ADR-007 §2). `lexTokens` are our
 * normalised, light-stemmed tokens; the database only turns them into a tsvector with the `simple`
 * configuration, so Postgres never applies its own analysis and index and query cannot drift.
 */
export interface IndexRow {
  ordinal: number;
  headingPath: string[];
  text: string;
  textNorm: string;
  lexTokens: string;
  embedding: number[];
  tokenCount: number;
  meta: { kind: Chunk["kind"] };
}

/** The heading path is searchable too: a question naming the section should find its chunks. */
export function toIndexRows(chunks: Chunk[], embeddings: number[][]): IndexRow[] {
  if (chunks.length !== embeddings.length) throw new Error("one embedding per chunk");
  return chunks.map((c, i) => ({
    ordinal: c.ordinal,
    headingPath: c.headingPath,
    text: c.text,
    textNorm: normalizeArabic(c.text),
    lexTokens: indexTokens(embeddingInput(c)).join(" "),
    embedding: embeddings[i] as number[],
    tokenCount: c.tokenCount,
    meta: { kind: c.kind },
  }));
}
