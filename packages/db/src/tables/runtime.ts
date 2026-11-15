import { createHash } from "node:crypto";
import {
  AppError,
  FindRowsRequest,
  Identifier,
  Json,
  TABLE_LIMITS,
  TableId,
  type TableRuntimeCall,
} from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client";
import { LeaseLostError } from "../repos/runtime";
import { currentWorkspace } from "../repos/scope";
import { canonicalJson } from "../repos/versions";
import { ensureUnique, type NormaliseSearch, readTable, searchText, type TableRecord, type TableScope } from "./repo";
import { appendTableRows, findTableRows, upsertTableRow } from "./rows";
import { validateRow } from "./validation";

const options = FindRowsRequest.omit({ cursor: true })
  .extend({
    where: z.unknown().optional(),
    limit: FindRowsRequest.shape.limit.default(10),
  })
  .strict();
const values = z.record(Identifier, Json);
const where = z.custom<unknown>((input) => input !== undefined);
const inputValues = z.strictObject({ values });
const inputUpdate = inputValues.extend({ where });
const inputUpsert = inputValues.extend({ on: Identifier });
const inputDelete = z.strictObject({ where });
const saved = z.object({ value: Json, rowCount: z.number().int().nonnegative() });

export interface TableRunContext {
  botId: string;
  conversationId: string;
  turnId: string;
  epoch: number;
  mode: "live" | "emulator" | "eval";
  step: number;
  ordinal: number;
}

export async function listRuntimeTableNames(tx: Tx, botId: string) {
  const rows = await tx.execute(sql`select name from bot_tables where bot_id = ${botId} order by name`);
  return rows.rows.map((row) => Identifier.parse(row["name"]));
}

function byName(table: TableRecord, data: Record<string, Json>): Record<string, Json> {
  return Object.fromEntries(
    Object.entries(data).map(([name, value]) => {
      const col = table.columns.find((candidate) => candidate.name === name);
      if (!col) throw new AppError("table_row_invalid", { message: "use a column name in the table schema" });
      return [col.id, value];
    }),
  );
}

function runtimeRow(table: TableRecord, row: { id: string; data: Record<string, Json> }): Json {
  return Object.fromEntries([
    ...table.columns.flatMap((col) => (Object.hasOwn(row.data, col.id) ? [[col.name, row.data[col.id] ?? null]] : [])),
    ["id", row.id],
  ]);
}

async function resolveTarget(tx: Tx, botId: string, target: TableRuntimeCall["target"]): Promise<TableScope> {
  if ("id" in target) return { botId, tableId: target.id };
  const row = await tx.execute(sql`select id from bot_tables where bot_id = ${botId} and name = ${target.name}`);
  if (!row.rows[0]) throw new AppError("not_found");
  return { botId, tableId: TableId.parse(row.rows[0]["id"]) };
}

async function matches(
  tx: Tx,
  table: TableRecord,
  scope: TableScope,
  filter: unknown,
  limit: number,
  normalize: NormaliseSearch,
) {
  const found = await findTableRows(tx, scope, { where: filter, sort: [], limit }, normalize);
  if (limit > 1 && found.nextCursor) {
    throw new AppError("validation_failed", {}, { detail: `Match at most ${limit} rows per write to ${table.name}.` });
  }
  return found.data;
}

async function execute(
  tx: Tx,
  scope: TableScope,
  table: TableRecord,
  call: TableRuntimeCall,
  normalize: NormaliseSearch,
): Promise<z.infer<typeof saved>> {
  if (call.operation === "find" || call.operation === "get") {
    const query = options.parse(call.input);
    const rows = await findTableRows(
      tx,
      scope,
      { ...query, limit: call.operation === "get" ? 1 : query.limit },
      normalize,
    );
    const data = rows.data.map((row) => runtimeRow(table, row));
    return { value: call.operation === "get" ? (data[0] ?? null) : data, rowCount: data.length };
  }
  if (call.operation === "insert") {
    const input = inputValues.parse(call.input);
    const [row] = await appendTableRows(tx, scope, [byName(table, input.values)], normalize);
    if (!row) throw new AppError("internal_error");
    return { value: runtimeRow(table, row), rowCount: 1 };
  }
  if (call.operation === "upsert") {
    const input = inputUpsert.parse(call.input);
    const result = await upsertTableRow(tx, scope, { on: input.on, values: byName(table, input.values) }, normalize);
    return { value: runtimeRow(table, result.row), rowCount: 1 };
  }

  if (call.operation === "delete") {
    const input = inputDelete.parse(call.input);
    const rows = await matches(tx, table, scope, input.where, TABLE_LIMITS.insertBatch, normalize);
    if (rows.length) {
      await tx.execute(sql`delete from table_rows where table_id = ${table.id}
        and id = any(${sql.param(rows.map((row) => row.id))}::text[])`);
      await tx.execute(sql`update bot_tables set row_count = row_count - ${rows.length} where id = ${table.id}`);
    }
    return { value: rows.length, rowCount: rows.length };
  }

  const input = inputUpdate.parse(call.input);
  const changes = byName(table, input.values);
  const single = call.surface === "card";
  const rows = await matches(tx, table, scope, input.where, single ? 1 : TABLE_LIMITS.insertBatch, normalize);
  if (!rows.length && single) throw new AppError("not_found");
  const next = rows.map(({ id, data }) => {
    const fields = validateRow(table.columns, { ...data, ...changes });
    return { id, data: fields, terms: searchText(fields, table.columns, normalize) };
  });
  if (next.length) {
    await ensureUnique(
      tx,
      table,
      next.map((row) => row.data),
      next.map((row) => row.id),
    );
    await tx.execute(sql`update table_rows r set data = input.data, lex = to_tsvector('simple', input.terms), updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(next)}::jsonb) as input(id text, data jsonb, terms text)
      where r.table_id = ${table.id} and r.id = input.id`);
  }
  const updated = next[0];
  return { value: single && updated ? runtimeRow(table, updated) : next.length, rowCount: next.length };
}

async function checkLease(tx: Tx, run: TableRunContext) {
  const guarded = await tx.execute(sql`select t.id from conversations c join turns t on t.conversation_id = c.id
    where c.id = ${run.conversationId} and c.bot_id = ${run.botId} and c.lease_epoch = ${run.epoch}
      and c.lease_until > now() and c.mode = 'live' and t.id = ${run.turnId}
      and t.status = 'running' and t.step_count < ${run.step} for update of c`);
  if (!guarded.rows.length) throw new LeaseLostError(run.conversationId);
}

/** Resolves a runtime call in its bot and records live writes before releasing the transaction. */
export async function runTableOperation(
  tx: Tx,
  run: TableRunContext,
  call: TableRuntimeCall,
  normalize: NormaliseSearch,
) {
  const write = call.operation !== "find" && call.operation !== "get";
  if (write && run.mode !== "live") throw new AppError("table_write_disabled");
  if (write) await checkLease(tx, run);
  const scope = await resolveTarget(tx, run.botId, call.target);
  const table = await readTable(tx, scope, write ? true : "share");
  if (table.columns.some((col) => col.name === "id"))
    throw new AppError("validation_failed", {}, { detail: "Rename the id column before using this table in a bot." });

  if (!write && run.mode !== "live")
    return { tableId: table.id, ...(await execute(tx, scope, table, call, normalize)) };

  const match = sql`turn_id = ${run.turnId} and step_seq = ${run.step} and call_ordinal = ${run.ordinal}`;
  const key = createHash("sha256")
    .update(canonicalJson([table.id, call.surface, call.operation, call.input]))
    .digest("hex");
  const existing = (await tx.execute(sql`select fingerprint, result from table_write_receipts where ${match}`)).rows[0];
  if (existing) {
    if (existing["fingerprint"] !== key) throw new AppError("table_replay_conflict");
    return { tableId: table.id, ...saved.parse(existing["result"]) };
  }
  const result = await execute(tx, scope, table, call, normalize);
  if (!write) return { tableId: table.id, ...result };

  await tx.execute(sql`insert into table_write_receipts
    (workspace_id, conversation_id, turn_id, table_id, step_seq, call_ordinal, fingerprint, result)
    values (${currentWorkspace}, ${run.conversationId}, ${run.turnId}, ${table.id}, ${run.step}, ${run.ordinal}, ${key}, ${JSON.stringify(result)}::jsonb)`);
  return { tableId: table.id, ...result };
}

/** A committed step will not be re-run and no longer needs its receipt. */
export async function clearTableReceipts(tx: Tx, turnId: string, committedStep?: number) {
  const committed = committedStep === undefined ? sql`` : sql`and step_seq <= ${committedStep}`;
  await tx.execute(sql`delete from table_write_receipts where turn_id = ${turnId} ${committed}`);
}
