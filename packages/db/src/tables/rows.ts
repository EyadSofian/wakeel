import { createHash } from "node:crypto";
import { AppError, type Column, type FindRowsRequest, Json, RowId } from "@wakeel/contracts";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client";
import { canonicalJson } from "../repos/versions";
import { compileRowFilter } from "./filter";
import {
  ensureUnique,
  insertRowsLocked,
  type NormaliseSearch,
  readTable,
  searchText,
  type TableRecord,
  type TableScope,
} from "./repo";
import { canonicalValue, validateRow } from "./validation";

const rowData = z.record(z.string(), Json);
const dbRow = z.object({ id: RowId, data: rowData });
const cursorData = z.object({ scope: z.string(), id: RowId, values: z.array(Json).max(3) });

function hash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

export type RowQuery = Omit<FindRowsRequest, "where"> & { where?: unknown };

export function presentTableRow(table: TableRecord, result: unknown) {
  if (!result) throw new AppError("not_found");
  const row = dbRow.parse(result);
  return { ...row, revision: `"${hash([table.revision, row.id, row.data])}"` };
}

function badCursor() {
  return new AppError("validation_failed", {}, { detail: "Run this search again without its previous cursor." });
}

function decodeCursor(cursor: string, scope: string, columns: Column[]) {
  // Three 16 KiB values fit into at most 88 KiB after JSON and base64 encoding.
  if (cursor.length > 90_000 || !/^[\w-]+$/.test(cursor)) throw badCursor();
  try {
    const data = cursorData.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (data.scope !== scope || data.values.length !== columns.length) throw badCursor();
    const values = columns.map((column, index) => {
      const value = data.values[index];
      return value == null ? null : canonicalValue(column, value);
    });
    return { ...data, values };
  } catch {
    throw badCursor();
  }
}

function sortTerms(table: TableRecord, sort: FindRowsRequest["sort"]) {
  if (new Set(sort.map((entry) => entry.column)).size !== sort.length)
    throw new AppError("validation_failed", {}, { detail: "Use each sort column once." });
  return sort.map(({ column, direction }) => {
    const field = table.columns.find((entry) => entry.name === column);
    if (!field || field.type === "json" || field.type === "boolean")
      throw new AppError("validation_failed", {}, { detail: "Sort by a string, enum, number or date column." });
    const value = sql`(table_rows.data ->> ${field.id}::text)`;
    const cast = field.type === "number" ? sql`::numeric` : field.type === "date" ? sql`::timestamptz` : sql`::text`;
    return { field, direction, at: sql`${value}${cast}`, cast };
  });
}

/** Keyset pagination reads one schema under a shared lock for the duration of a page. */
export async function findTableRows(tx: Tx, key: TableScope, query: RowQuery, normalize: NormaliseSearch) {
  const table = await readTable(tx, key, "share");
  const terms = sortTerms(table, query.sort);
  const filters = [sql`table_id = ${table.id}`];
  if (query.where !== undefined) filters.push(compileRowFilter(table.columns, query.where));
  const scope = hash([table.id, table.revision, query.where, query.sort, query.search]);
  if (query.search?.trim()) {
    const lexical = normalize(query.search);
    filters.push(lexical ? sql`lex @@ plainto_tsquery('simple', ${lexical})` : sql`false`);
  }

  if (query.cursor) {
    const after = decodeCursor(
      query.cursor,
      scope,
      terms.map((term) => term.field),
    );
    const equal: SQL[] = [];
    const choices: SQL[] = [];
    for (const [i, term] of terms.entries()) {
      const value = after.values[i];
      const param = value == null ? null : String(value);
      const compare = term.direction === "asc" ? sql`>` : sql`<`;
      if (param !== null) {
        const later = sql`(${term.at} ${compare} ${param}${term.cast} or ${term.at} is null)`;
        choices.push(sql`(${sql.join([...equal, later], sql` and `)})`);
      }
      equal.push(sql`${term.at} is not distinct from ${param}${term.cast}`);
    }
    choices.push(sql`(${sql.join([...equal, sql`id > ${after.id}`], sql` and `)})`);
    filters.push(sql`(${sql.join(choices, sql` or `)})`);
  }
  const order = terms.map((term) => sql`${term.at} ${term.direction === "asc" ? sql`asc` : sql`desc`} nulls last`);
  order.push(sql`id asc`);
  const rows = await tx.execute(sql`select id, data from table_rows
    where ${sql.join(filters, sql` and `)} order by ${sql.join(order, sql`, `)} limit ${query.limit + 1}`);
  const data = rows.rows.slice(0, query.limit).map((row) => presentTableRow(table, row));
  const last = data.at(-1);
  const nextCursor =
    last && rows.rows.length > query.limit
      ? Buffer.from(
          JSON.stringify({ scope, id: last.id, values: terms.map((term) => last.data[term.field.id] ?? null) }),
        ).toString("base64url")
      : null;
  return { data, nextCursor, rowCount: table.rowCount };
}

async function readRow(tx: Tx, table: TableRecord, rowId: string) {
  const row = await tx.execute(sql`select id, data from table_rows where table_id = ${table.id} and id = ${rowId}`);
  return presentTableRow(table, row.rows[0]);
}

export async function getTableRow(tx: Tx, key: TableScope, rowId: string) {
  return readRow(tx, await readTable(tx, key, "share"), rowId);
}

async function updateLocked(
  tx: Tx,
  table: TableRecord,
  row: ReturnType<typeof presentTableRow>,
  values: Record<string, Json>,
  normalize: NormaliseSearch,
) {
  const data = validateRow(table.columns, { ...row.data, ...values });
  await ensureUnique(tx, table, [data], row.id);
  const lex = searchText(data, table.columns, normalize);
  await tx.execute(sql`update table_rows set data = ${JSON.stringify(data)}::jsonb,
    lex = to_tsvector('simple', ${lex}), updated_at = now() where id = ${row.id} and table_id = ${table.id}`);
  return presentTableRow(table, { id: row.id, data });
}

export async function patchTableRow(
  tx: Tx,
  key: TableScope,
  rowId: string,
  revision: string,
  values: Record<string, Json>,
  normalize: NormaliseSearch,
) {
  const table = await readTable(tx, key, true);
  const row = await readRow(tx, table, rowId);
  if (row.revision !== revision) throw new AppError("revision_conflict");
  return updateLocked(tx, table, row, values, normalize);
}

export async function removeTableRow(tx: Tx, key: TableScope, rowId: string, revision: string) {
  const table = await readTable(tx, key, true);
  const row = await readRow(tx, table, rowId);
  if (row.revision !== revision) throw new AppError("revision_conflict");
  await tx.execute(sql`delete from table_rows where id = ${row.id} and table_id = ${table.id}`);
  await tx.execute(sql`update bot_tables set row_count = row_count - 1 where id = ${table.id}`);
}

export async function upsertTableRow(
  tx: Tx,
  key: TableScope,
  input: { on: string; values: Record<string, Json> },
  normalize: NormaliseSearch,
  revision?: string,
) {
  const table = await readTable(tx, key, true);
  const column = table.columns.find((field) => field.name === input.on && field.unique);
  const match = column && input.values[column.id];
  if (!column || match == null)
    throw new AppError("table_row_invalid", { message: "provide a value for the selected unique column" });
  const value = canonicalValue(column, match);
  const existing = await tx.execute(sql`select id, data from table_rows where table_id = ${table.id}
    and (data -> ${column.id}::text) = ${JSON.stringify(value)}::jsonb`);
  if (existing.rows[0]) {
    const row = presentTableRow(table, existing.rows[0]);
    if (revision !== undefined && revision !== row.revision) throw new AppError("revision_conflict");
    return { created: false, row: await updateLocked(tx, table, row, input.values, normalize) };
  }
  if (revision !== undefined) throw new AppError("revision_conflict");
  const [row] = await insertRowsLocked(tx, table, [input.values], normalize);
  return { created: true, row: presentTableRow(table, row) };
}

export async function appendTableRows(tx: Tx, key: TableScope, inputs: unknown[], normalize: NormaliseSearch) {
  const table = await readTable(tx, key, true);
  return (await insertRowsLocked(tx, table, inputs, normalize)).map((row) => presentTableRow(table, row));
}
