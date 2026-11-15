import { createHash } from "node:crypto";
import { AppError, type Column, type Json, newId, RowId, TABLE_LIMITS, type TableSchema } from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client";
import { getBot } from "../repos/bots";
import { currentWorkspace } from "../repos/scope";
import { getVersion } from "../repos/versions";
import { checkedSchema, validateRow } from "./validation";

const defaults = { tables: 50, rows: 100_000 } as const;
const tableFields = sql`id, name, description, columns, row_count`;
const tableRow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  columns: z.unknown(),
  row_count: z.number().int().nonnegative(),
});

export type TableDefinition = Omit<TableSchema, "id">;
export interface TableScope {
  botId: string;
  tableId: string;
}
export type TableRecord = TableSchema & { rowCount: number; revision: string };
export type NormaliseSearch = (text: string) => string;

function tableRecord(raw: unknown): TableRecord {
  if (!raw) throw new AppError("not_found");
  const row = tableRow.parse(raw);
  const schema = checkedSchema({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    columns: row.columns,
  });
  const hash = createHash("sha256").update(JSON.stringify(schema)).digest("base64url");
  return { ...schema, rowCount: row.row_count, revision: `"${hash}"` };
}

export async function readTable(tx: Tx, { botId, tableId }: TableScope, lock: boolean | "share" = false) {
  await getBot(tx, botId);
  const selected = await tx.execute(sql`select ${tableFields} from bot_tables
    where bot_id = ${botId} and id = ${tableId} ${lock === "share" ? sql`for share` : lock ? sql`for update` : sql``}`);
  return tableRecord(selected.rows[0]);
}

export async function getTable(tx: Tx, scope: TableScope): Promise<TableRecord> {
  return readTable(tx, scope);
}

export async function listTables(tx: Tx, botId: string, cursor = "", limit = 50) {
  await getBot(tx, botId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("validation_failed");
  const result = await tx.execute(sql`select ${tableFields} from bot_tables where bot_id = ${botId}
    and id > ${cursor} order by id limit ${limit + 1}`);
  const data = result.rows.slice(0, limit).map(tableRecord);
  return { data, nextCursor: result.rows.length > limit ? (data.at(-1)?.id ?? null) : null };
}

function nameConflict(error: unknown): never {
  if (error instanceof Error && (error.cause as { code?: string } | undefined)?.code === "23505") {
    throw new AppError("validation_failed", {}, { detail: "A table already uses this name in the bot." });
  }
  throw error;
}

export async function createTable(tx: Tx, botId: string, input: TableDefinition): Promise<TableRecord> {
  const schema = checkedSchema({ ...input, id: newId("tbl") });
  await tx.execute(sql`select id from bots where id = ${botId} for update`);
  await getBot(tx, botId);
  const count = await tx.execute(sql`select count(*)::int as count from bot_tables where bot_id = ${botId}`);
  if (z.number().parse(count.rows[0]?.["count"]) >= defaults.tables) {
    throw new AppError("validation_failed", {}, { detail: `This bot can have up to ${defaults.tables} tables.` });
  }
  const result = await tx
    .execute(sql`insert into bot_tables (id, workspace_id, bot_id, name, description, columns)
    values (${schema.id}, ${currentWorkspace}, ${botId}, ${schema.name}, ${schema.description ?? null}, ${JSON.stringify(schema.columns)}::jsonb)
    returning ${tableFields}`)
    .catch(nameConflict);
  return tableRecord(result.rows[0]);
}

function assertRevision(current: TableRecord, revision: string) {
  if (current.revision !== revision) throw new AppError("revision_conflict");
}

export function searchText(data: Record<string, Json>, columns: Column[], normalize: NormaliseSearch): string {
  const values = columns.flatMap((column) => {
    const value = data[column.id];
    if (!column.searchable || value == null) return [];
    return [typeof value === "string" ? value : JSON.stringify(value)];
  });
  return values.length ? normalize(values.join(" ")) : "";
}

export async function ensureUnique(tx: Tx, table: TableRecord, rows: Record<string, Json>[], except?: string) {
  for (const column of table.columns.filter((column) => column.unique)) {
    const values = rows.flatMap((data) => (data[column.id] == null ? [] : [data[column.id]]));
    if (!values.length) continue;
    const otherRow = except === undefined ? sql`` : sql`and r.id <> ${except}`;
    const conflict = await tx.execute(sql`with pending as (
      select value from jsonb_array_elements(${JSON.stringify(values)}::jsonb)
    )
    select exists(select 1 from pending group by value having count(*) > 1)
      or exists(select 1 from pending join table_rows r on (r.data -> ${column.id}::text) = pending.value
        where r.table_id = ${table.id} ${otherRow}) as found`);
    if (conflict.rows[0]?.["found"]) throw new AppError("unique_violation", { column: column.name });
  }
}

export async function insertRowsLocked(tx: Tx, table: TableRecord, inputs: unknown[], normalize: NormaliseSearch) {
  if (!inputs.length || inputs.length > TABLE_LIMITS.insertBatch) throw new AppError("validation_failed");
  if (table.rowCount + inputs.length > defaults.rows) {
    throw new AppError("table_limit_reached", { table: table.name, limit: defaults.rows });
  }
  const rows = inputs.map((input) => {
    const data = validateRow(table.columns, input);
    return { id: newId("row"), data, terms: searchText(data, table.columns, normalize) };
  });
  await ensureUnique(
    tx,
    table,
    rows.map((row) => row.data),
  );
  await tx.execute(sql`insert into table_rows (id, workspace_id, table_id, data, lex)
    select id, ${currentWorkspace}, ${table.id}, data, to_tsvector('simple', terms)
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as input(id text, data jsonb, terms text)`);
  await tx.execute(sql`update bot_tables set row_count = row_count + ${rows.length} where id = ${table.id}`);
  return rows.map(({ terms: _terms, ...row }) => row);
}

/** The table write lock covers data validation and the uniqueness check for the entire batch. */
export async function insertTableRows(tx: Tx, scope: TableScope, inputs: unknown[], normalize: NormaliseSearch) {
  return insertRowsLocked(tx, await readTable(tx, scope, true), inputs, normalize);
}

async function checkColumnChanges(tx: Tx, current: TableRecord, next: TableSchema, normalize: NormaliseSearch) {
  const proposed = new Map(next.columns.map((column) => [column.id, column]));
  const previous = new Map(current.columns.map((column) => [column.id, column]));
  const erased = current.columns.filter((column) => !proposed.has(column.id)).map((column) => column.id);
  const changedType = current.columns.filter(
    (column) => proposed.has(column.id) && proposed.get(column.id)?.type !== column.type,
  );
  const rebuildSearch = [...current.columns, ...next.columns].some(
    (column) => Boolean(previous.get(column.id)?.searchable) !== Boolean(proposed.get(column.id)?.searchable),
  );

  for (const column of next.columns.filter((column) => column.unique && !previous.get(column.id)?.unique)) {
    const duplicates = await tx.execute(sql`select 1 from table_rows where table_id = ${current.id}
      and nullif(data -> ${column.id}::text, 'null'::jsonb) is not null group by data -> ${column.id}::text
      having count(*) > 1 limit 1`);
    if (duplicates.rows.length) throw new AppError("unique_violation", { column: column.name });
  }

  const requiresValidation =
    changedType.length > 0 ||
    next.columns.some((column) => {
      const old = previous.get(column.id);
      return (
        (column.required && !old?.required) || JSON.stringify(column.enumValues) !== JSON.stringify(old?.enumValues)
      );
    });
  if (!requiresValidation && !erased.length && !rebuildSearch) return;

  // Bound the amount of row data in application memory while the mutation holds the table lock.
  let cursor = "";
  const batchSize = 250;
  while (true) {
    const batch = await tx.execute(sql`select id, data from table_rows where table_id = ${current.id}
      and id > ${cursor} order by id limit ${batchSize}`);
    const rows = batch.rows.map((row) => {
      const id = RowId.parse(row["id"]);
      const data = z.record(z.string(), z.unknown()).parse(row["data"]);
      for (const column of changedType) {
        if (data[column.id] != null)
          throw new AppError("table_row_invalid", {
            message: `clear the values in ${column.name} before changing its type`,
          });
      }
      for (const key of erased) delete data[key];
      const valid = validateRow(next.columns, data);
      return { id, data: valid, terms: searchText(valid, next.columns, normalize) };
    });
    if (rows.length && (erased.length || rebuildSearch)) {
      await tx.execute(sql`update table_rows as r set data = input.data,
        lex = to_tsvector('simple', input.terms), updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as input(id text, data jsonb, terms text)
        where r.table_id = ${current.id} and r.id = input.id`);
    }
    if (rows.length < batchSize) break;
    cursor = rows.at(-1)?.id ?? cursor;
  }
}

/** A new schema replaces the old one atomically, including any affected row data. */
export async function updateTable(
  tx: Tx,
  scope: TableScope,
  revision: string,
  input: TableDefinition,
  normalize: NormaliseSearch,
): Promise<TableRecord> {
  const current = await readTable(tx, scope, true);
  assertRevision(current, revision);
  const next = checkedSchema({ ...input, id: current.id });
  await checkColumnChanges(tx, current, next, normalize);
  const result = await tx
    .execute(sql`update bot_tables set name = ${next.name}, description = ${next.description ?? null},
    columns = ${JSON.stringify(next.columns)}::jsonb, updated_at = now() where id = ${current.id} returning ${tableFields}`)
    .catch(nameConflict);
  return tableRecord(result.rows[0]);
}

export async function deleteTable(tx: Tx, scope: TableScope, revision: string): Promise<void> {
  await tx.execute(sql`select id from bots where id = ${scope.botId} for update`);
  const current = await readTable(tx, scope, true);
  assertRevision(current, revision);
  const bot = await getBot(tx, scope.botId);
  if (bot.publishedVersionId) {
    const { definition } = await getVersion(tx, scope.botId, bot.publishedVersionId);
    const uses = definition.workflows.flatMap((workflow) =>
      workflow.nodes.flatMap((node) => {
        const operations = node.type === "autonomous" ? node.tools : "cards" in node ? node.cards : [];
        return operations.some((operation) => operation.type === "table" && operation.tableId === scope.tableId)
          ? [`${workflow.name} / ${node.name}`]
          : [];
      }),
    );
    if (uses.length) throw new AppError("resource_in_use", { usages: uses.join(", ") });
  }
  await tx.execute(sql`delete from bot_tables where id = ${current.id}`);
}
