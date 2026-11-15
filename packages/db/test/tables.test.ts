import { Column, newElementId, newId } from "@wakeel/contracts";
import pg from "pg";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import { createBot, createDatabase, createWorkspace, type Database, sql } from "../src/index";
import { compileRowFilter } from "../src/tables/filter";
import { createTable, deleteTable, getTable, insertTableRows, updateTable } from "../src/tables/repo";

const urls = inject("db");
let db: Database;
let client: pg.Client;

async function tenant() {
  const user = newId("usr");
  await client.query("insert into users (id, email, name) values ($1, $2, 'Tables')", [user, `${user}@example.test`]);
  const { workspace } = await createWorkspace(db, {
    name: "Tables",
    slug: `tables-${user.slice(-12)}`,
    ownerUserId: user,
  });
  const ws = workspace.id;
  const bot = await db.withWorkspace(ws, (tx) => createBot(tx, { name: "المتجر", slug: "shop", createdBy: user }));
  return { ws, botId: bot.id, tableId: newId("tbl"), rowId: newId("row") };
}

const columns = JSON.stringify([{ id: newElementId("col"), name: "order", type: "string" }]);
let a: Awaited<ReturnType<typeof tenant>>;
let b: Awaited<ReturnType<typeof tenant>>;

beforeAll(async () => {
  db = createDatabase({ url: urls.rw });
  client = new pg.Client({ connectionString: urls.rw });
  await client.connect();
  a = await tenant();
  b = await tenant();
  for (const t of [a, b]) {
    await db.withWorkspace(t.ws, async (tx) => {
      await tx.execute(sql`insert into bot_tables (id, workspace_id, bot_id, name, columns)
        values (${t.tableId}, ${t.ws}, ${t.botId}, 'orders', ${columns}::jsonb)`);
      await tx.execute(sql`insert into table_rows (id, workspace_id, table_id, data)
        values (${t.rowId}, ${t.ws}, ${t.tableId}, '{}'::jsonb)`);
    });
  }
});

afterAll(async () => {
  await client?.end();
  await db?.close();
});

test("table schemas and rows are visible only in their workspace", async () => {
  for (const t of [a, b]) {
    await db.withWorkspace(t.ws, async (tx) => {
      expect((await tx.execute(sql`select id from bot_tables`)).rows).toEqual([{ id: t.tableId }]);
      expect((await tx.execute(sql`select id from table_rows`)).rows).toEqual([{ id: t.rowId }]);
    });
  }
  expect((await client.query("select id from bot_tables")).rows).toEqual([]);
  expect((await client.query("select id from table_rows")).rows).toEqual([]);
});

test("composite foreign keys reject a bot or table owned by another workspace", async () => {
  await expect(
    db.withWorkspace(b.ws, (tx) =>
      tx.execute(sql`insert into bot_tables (id, workspace_id, bot_id, name, columns)
        values (${newId("tbl")}, ${b.ws}, ${a.botId}, 'blocked', ${columns}::jsonb)`),
    ),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
  await expect(
    db.withWorkspace(b.ws, (tx) =>
      tx.execute(sql`insert into table_rows (id, workspace_id, table_id, data)
        values (${newId("row")}, ${b.ws}, ${a.tableId}, '{}'::jsonb)`),
    ),
  ).rejects.toMatchObject({ cause: { code: "23503" } });
});

test("scopes table CRUD to its bot and validates rows before committing", async () => {
  const order = newElementId("col");
  const column = Column.parse({ id: order, name: "order", type: "string", required: true, unique: true });
  const schema = await db.withWorkspace(a.ws, (tx) =>
    createTable(tx, a.botId, {
      name: "returns",
      columns: [column],
    }),
  );
  const scope = { botId: a.botId, tableId: schema.id };
  const lex = (value: string) => value;
  await expect(db.withWorkspace(b.ws, (tx) => getTable(tx, scope))).rejects.toMatchObject({ code: "not_found" });
  await expect(db.withWorkspace(a.ws, (tx) => insertTableRows(tx, scope, [{}], lex))).rejects.toMatchObject({
    code: "table_row_invalid",
  });

  const fixture = [{ [order]: "طلب ORD-12" }];
  await expect(
    db.withWorkspace(a.ws, (tx) => insertTableRows(tx, scope, [...fixture, ...fixture], lex)),
  ).rejects.toMatchObject({ code: "unique_violation" });
  await expect(
    db.withWorkspace(a.ws, (tx) => insertTableRows(tx, scope, [{ [order]: "س".repeat(8_192) }], lex)),
  ).rejects.toMatchObject({ code: "table_row_invalid" });
  const writes = await Promise.allSettled([
    db.withWorkspace(a.ws, (tx) => insertTableRows(tx, scope, fixture, lex)),
    db.withWorkspace(a.ws, (tx) => insertTableRows(tx, scope, fixture, lex)),
  ]);
  expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(writes).toContainEqual(
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "unique_violation" }) }),
  );
  const rows = await db.withWorkspace(a.ws, (tx) =>
    tx.execute(
      sql`select data from table_rows where table_id = ${schema.id} and ${compileRowFilter(schema.columns, { order: { contains: "ORD-12" } })}`,
    ),
  );
  expect(rows.rows).toEqual([{ data: fixture[0] }]);

  const renamed = { ...column, name: "orderNumber" };
  const definition = { name: "returns", columns: [renamed] };
  const updated = await db.withWorkspace(a.ws, (tx) => updateTable(tx, scope, schema.revision, definition, lex));
  expect(updated.revision).not.toBe(schema.revision);
  expect(updated.rowCount).toBe(1);
  await expect(
    db.withWorkspace(a.ws, (tx) => updateTable(tx, scope, schema.revision, definition, lex)),
  ).rejects.toMatchObject({
    code: "revision_conflict",
  });
  await expect(
    db.withWorkspace(a.ws, (tx) =>
      updateTable(
        tx,
        scope,
        updated.revision,
        {
          ...definition,
          columns: [{ ...renamed, type: "number" }],
        },
        lex,
      ),
    ),
  ).rejects.toMatchObject({ code: "table_row_invalid" });
  await db.withWorkspace(a.ws, (tx) => deleteTable(tx, scope, updated.revision));
  await expect(db.withWorkspace(a.ws, (tx) => getTable(tx, scope))).rejects.toMatchObject({ code: "not_found" });
});
