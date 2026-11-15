import { AppError, KbSettings, SearchCandidate, type SearchFilters } from "@wakeel/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { knowledgeBases } from "../schema/kb";

/** Resolves every requested base, including its bot boundary, before a model receives the query. */
export async function resolveSearchBases(tx: Tx, botId: string, kbIds: readonly string[]) {
  const unique = [...new Set(kbIds)];
  if (!unique.length) throw new AppError("validation_failed");
  const rows = await tx
    .select()
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.botId, botId), inArray(knowledgeBases.id, unique)));
  if (rows.length !== unique.length) throw new AppError("not_found");
  return rows.map((row) => ({
    id: row.id,
    embeddingModel: row.embeddingModel,
    indexVersion: row.indexVersion,
    ...KbSettings.parse(row.settings),
  }));
}

/** Both legs share one parameterized predicate and the active index version (architecture §8.2). */
export async function searchCandidates(
  tx: Tx,
  botId: string,
  input: { kbIds: readonly string[]; vector: number[]; tokens: string[]; filters?: SearchFilters },
) {
  if (!input.kbIds.length) return { dense: [], lexical: [] };
  if (input.vector.length !== 1024 || input.vector.some((n) => !Number.isFinite(n)))
    throw new AppError("validation_failed");
  const ids = sql.join(
    input.kbIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const filters = [
    sql`k.bot_id = ${botId}`,
    sql`c.kb_id in (${ids})`,
    sql`c.index_version = k.index_version`,
    sql`d.status = 'ready'`,
  ];
  const f = input.filters;
  if (f?.documentIds)
    filters.push(
      sql`c.document_id in (${sql.join(
        f.documentIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  if (f?.sourceIds)
    filters.push(
      sql`d.source_id in (${sql.join(
        f.sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  if (f?.languages)
    filters.push(
      sql`d.lang in (${sql.join(
        f.languages.map((lang) => sql`${lang}`),
        sql`, `,
      )})`,
    );
  const where = sql.join(filters, sql` and `);
  const columns = sql`c.id as "chunkId", c.document_id as "documentId", c.kb_id as "kbId", d.source_id as "sourceId", d.lang as language, d.title, d.uri, c.heading_path as "headingPath", c.text, c.meta`;
  const joins = sql`kb_chunks c join knowledge_bases k on k.id = c.kb_id and k.workspace_id = c.workspace_id join kb_documents d on d.id = c.document_id and d.workspace_id = c.workspace_id`;
  const vector = `[${input.vector.join(",")}]`;
  await tx.execute(sql`set local hnsw.iterative_scan = 'relaxed_order'`);
  // Relaxed HNSW scans may emit slightly out of order; materialize then order the returned set.
  const dense = await tx.execute(sql`with nearest as materialized (
    select ${columns}, c.embedding <=> ${vector}::vector as distance
    from ${joins} where ${where} and c.embedding is not null
    order by c.embedding <=> ${vector}::vector limit 30
  ) select *, 1 - distance as score from nearest order by distance + 0, "chunkId"`);
  const lexical = input.tokens.length
    ? await tx.execute(sql`
    select ${columns}, ts_rank_cd(c.lex, plainto_tsquery('simple', ${input.tokens.join(" ")})) as score
    from ${joins} where ${where} and c.lex @@ plainto_tsquery('simple', ${input.tokens.join(" ")})
    order by score desc, c.id limit 30`)
    : { rows: [] };
  return {
    dense: dense.rows.map((row) => SearchCandidate.parse(row)),
    lexical: lexical.rows.map((row) => SearchCandidate.parse(row)),
  };
}
