import { createHash } from "node:crypto";
import { normalizeArabic } from "../../src/arabic";
import { type Chunk, chunkMarkdown } from "../../src/chunk";
import { scoreRanking } from "../metrics";
import { type Page, pages } from "./pages";
import { LOCALES, type Question, questions, SLICES, type Slice } from "./questions";

/**
 * The realistic golden set (task 8.9, ADR-056 G1): long course pages split by the production
 * chunker, and questions whose relevant chunks are those of the named course that contain the
 * answer. A question whose answer no single chunk holds fails the build: that is the set saying the
 * chunking lost the fact, not a label to relax.
 */

export interface RealisticChunk extends Pick<Chunk, "ordinal" | "headingPath" | "text" | "kind"> {
  key: string;
  page: Page;
}

export interface LabelledQuestion extends Question {
  relevant: string[];
}

export function realisticChunks(): RealisticChunk[] {
  return pages.flatMap((page) =>
    chunkMarkdown(page.markdown).map((chunk) => ({
      key: `${page.key}#${chunk.ordinal}`,
      page,
      ordinal: chunk.ordinal,
      headingPath: chunk.headingPath,
      text: chunk.text,
      kind: chunk.kind,
    })),
  );
}

export function labelQuestions(chunks: readonly RealisticChunk[]): LabelledQuestion[] {
  return questions.map((q) => {
    if (!q.course || q.answer === undefined) return { ...q, relevant: [] };
    const answer = normalizeArabic(q.answer);
    const relevant = chunks
      .filter((c) => c.page.key === q.course && normalizeArabic(c.text).includes(answer))
      .map((c) => c.key);
    if (relevant.length === 0) throw new Error(`${q.key}: no chunk of ${q.course} contains "${q.answer}"`);
    return { ...q, relevant };
  });
}

export function realisticSet() {
  const chunks = realisticChunks();
  const labelled = labelQuestions(chunks);
  const fixtureHash = createHash("sha256")
    .update(
      JSON.stringify({
        pages,
        questions: labelled.map(({ key, query, history, relevant }) => [key, query, history, relevant]),
      }),
    )
    .digest("hex");
  return { chunks, questions: labelled, fixtureHash };
}

export interface RealisticRanking {
  key: string;
  slice: Slice;
  locale: string;
  query: string;
  /** The query that was searched: the follow-up as asked, or its rewrite. */
  searched: string;
  relevant: readonly string[];
  dense: readonly string[];
  hybrid: readonly string[];
}

/** ADR-056 G1: recall@5 at least this on every answerable slice of the realistic set. */
export const REALISTIC_MIN_RECALL_AT_5 = 0.9;

/**
 * Recall@5 and MRR per slice and per locale, dense and hybrid. Unanswerable questions have no
 * relevant chunk; they are counted, not scored, and serve the grounding gate (G2).
 */
export function evaluateRealistic(rows: readonly RealisticRanking[]) {
  const answerable = rows.filter((r) => r.relevant.length > 0);
  const mean = (cases: readonly RealisticRanking[], kind: "dense" | "hybrid") => {
    const scores = cases.map((r) => scoreRanking(r[kind], r.relevant));
    const n = Math.max(1, cases.length);
    return {
      recallAt5: scores.reduce((sum, s) => sum + s.recallAt5, 0) / n,
      mrr: scores.reduce((sum, s) => sum + s.mrr, 0) / n,
    };
  };
  const slices = SLICES.filter((s) => s !== "unanswerable").map((slice) => {
    const cases = answerable.filter((r) => r.slice === slice);
    const hybrid = mean(cases, "hybrid");
    return {
      slice,
      count: cases.length,
      dense: mean(cases, "dense"),
      hybrid,
      passed: cases.length > 0 && hybrid.recallAt5 >= REALISTIC_MIN_RECALL_AT_5,
    };
  });
  const locales = LOCALES.map((locale) => {
    const cases = answerable.filter((r) => r.locale === locale);
    return { locale, count: cases.length, dense: mean(cases, "dense"), hybrid: mean(cases, "hybrid") };
  });
  return {
    slices,
    locales,
    unanswerable: rows.filter((r) => r.relevant.length === 0).length,
    passed: slices.every((s) => s.passed),
  };
}

/** Runs every question through the supplied retrieval; a follow-up is searched as `rewrite` makes it. */
export async function runRealisticSuite(options: {
  retrieve(query: string): Promise<{ dense: string[]; hybrid: string[] }>;
  /** ADR-055's query rewrite; without it a follow-up is searched as asked. */
  rewrite?(question: LabelledQuestion): Promise<string>;
  onProgress?(completed: number, total: number): void;
}) {
  const startedAt = new Date().toISOString();
  const set = realisticSet();
  const rows: RealisticRanking[] = [];
  for (const q of set.questions) {
    const searched = q.history && options.rewrite ? await options.rewrite(q) : q.query;
    const result = await options.retrieve(searched);
    rows.push({
      key: q.key,
      slice: q.slice,
      locale: q.locale,
      query: q.query,
      searched,
      relevant: q.relevant,
      ...result,
    });
    options.onProgress?.(rows.length, set.questions.length);
  }
  return {
    set: "realistic",
    startedAt,
    finishedAt: new Date().toISOString(),
    fixtureHash: set.fixtureHash,
    chunkCount: set.chunks.length,
    queryCount: rows.length,
    followUps: options.rewrite ? "rewritten" : "as asked",
    cutoff: { recall: 5, mrr: 30 },
    ...evaluateRealistic(rows),
    cases: rows,
  };
}
