import { createHash } from "node:crypto";
import { corpus, queries } from "./corpus";
import { evaluateRankings, type RankingCase } from "./metrics";

/** Real-provider adapters supply ranked corpus keys; this runner owns all judgments and metrics. */
export async function runRetrievalSuite(options: {
  retrieve(query: string): Promise<{ dense: string[]; hybrid: string[] }>;
  onProgress?(completed: number, total: number): void;
}) {
  const startedAt = new Date().toISOString();
  const rows: RankingCase[] = [];
  for (const q of queries) {
    const result = await options.retrieve(q.query);
    rows.push({ locale: q.locale, query: q.query, relevant: q.relevant, ...result });
    options.onProgress?.(rows.length, queries.length);
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    fixtureHash: createHash("sha256").update(JSON.stringify({ corpus, queries })).digest("hex"),
    corpusCount: corpus.length,
    queryCount: rows.length,
    cutoff: { recall: 5, mrr: 30 },
    ...evaluateRankings(rows),
    cases: rows,
  };
}
