import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { createDatabase, type Database } from "../src/index";
import { sql } from "../src/sql";
import { tenantPairs } from "../src/testing/index";

/**
 * Acceptance for task 0.5: a table created with the standard policy is invisible to the other
 * tenant and to a connection with no workspace set. Every case runs twice, A→B and B→A.
 */
const urls = inject("db");
const table = `t_iso_${Math.random().toString(36).slice(2, 8)}`;

let db: Database;
/** A raw app_rw connection that never sets a workspace: what a forgotten withWorkspace would be. */
let bare: pg.Client;

beforeAll(async () => {
  const migrator = new pg.Client({ connectionString: urls.migrator });
  await migrator.connect();
  await migrator.query(`create table ${table} (id text primary key, workspace_id text not null, body text not null)`);
  await migrator.query(`call app_internal.enable_tenant_rls('${table}')`);
  await migrator.end();

  db = createDatabase({ url: urls.rw, maxConnections: 4 });
  bare = new pg.Client({ connectionString: urls.rw });
  await bare.connect();
});

afterAll(async () => {
  await bare?.end();
  await db?.close();
});

const rows = (workspaceId: string) =>
  db.withWorkspace(workspaceId, async (tx) => {
    const result = await tx.execute(sql.raw(`select id, workspace_id, body from ${table} order by id`));
    return result.rows as { id: string; workspace_id: string; body: string }[];
  });

/**
 * Postgres reports an RLS violation as SQLSTATE 42501 ("new row violates row-level security policy").
 * Drizzle wraps driver errors, so look through `cause`.
 */
const expectRlsViolation = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  let current: unknown = error;
  while (current instanceof Error && !("code" in current) && current.cause !== undefined) current = current.cause;
  expect(current).toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
};

const insert = (workspaceId: string, id: string, owner = workspaceId) =>
  db.withWorkspace(workspaceId, (tx) =>
    tx.execute(sql`insert into ${sql.identifier(table)} (id, workspace_id, body) values (${id}, ${owner}, ${"مرحبا"})`),
  );

describe.each(tenantPairs())("owner $owner, other $other", ({ owner, other }) => {
  const id = `${owner}:row`;

  beforeAll(async () => {
    await insert(owner, id);
  });

  test("the owner sees its row", async () => {
    expect((await rows(owner)).map((r) => r.id)).toContain(id);
  });

  test("the other tenant sees none of the owner's rows", async () => {
    expect((await rows(other)).filter((r) => r.workspace_id === owner)).toEqual([]);
  });

  test("a connection with no workspace set sees nothing at all", async () => {
    const result = await bare.query(`select count(*)::int as n from ${table}`);
    expect(result.rows[0].n).toBe(0);
  });

  test("the other tenant cannot update or delete the owner's row", async () => {
    const updated = await db.withWorkspace(other, (tx) =>
      tx.execute(sql`update ${sql.identifier(table)} set body = 'stolen' where id = ${id}`),
    );
    const deleted = await db.withWorkspace(other, (tx) =>
      tx.execute(sql`delete from ${sql.identifier(table)} where id = ${id}`),
    );
    expect(updated.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    expect((await rows(owner)).find((r) => r.id === id)?.body).toBe("مرحبا");
  });

  test("the other tenant cannot write a row into the owner's workspace", async () => {
    await expectRlsViolation(insert(other, `${other}:forged`, owner));
  });

  test("the owner cannot move its row to another workspace", async () => {
    await expectRlsViolation(
      db.withWorkspace(owner, (tx) =>
        tx.execute(sql`update ${sql.identifier(table)} set workspace_id = ${other} where id = ${id}`),
      ),
    );
  });
});

describe("a reused connection after its workspace transaction ended (ADR-014)", () => {
  // A pooled connection that has run withWorkspace once reports app.workspace_id as '' (not NULL)
  // afterwards. The policy must treat that as unset: nothing visible, nothing writable.
  let reused: pg.Client;

  beforeAll(async () => {
    reused = new pg.Client({ connectionString: urls.rw });
    await reused.connect();
    const [{ owner }] = tenantPairs();
    await reused.query("begin");
    await reused.query("select set_config('app.workspace_id', $1, true)", [owner]);
    await reused.query("commit");
  });

  afterAll(async () => {
    await reused?.end();
  });

  test("the setting really is empty, not NULL", async () => {
    const { rows } = await reused.query("select current_setting('app.workspace_id', true) as v");
    expect(rows[0].v).toBe("");
  });

  test("it cannot write a row with an empty workspace_id", async () => {
    await expectRlsViolation(reused.query(`insert into ${table} values ('empty-ws', '', 'x')`));
  });

  test("it sees no rows, including any with an empty workspace_id", async () => {
    const m = new pg.Client({ connectionString: urls.superuser });
    await m.connect();
    try {
      // Plant a row with workspace_id '' as the superuser, which bypasses RLS.
      await m.query(`insert into ${table} values ('planted-empty', '', 'x')`);
      const { rows } = await reused.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n).toBe(0);
    } finally {
      await m.query(`delete from ${table} where id = 'planted-empty'`);
      await m.end();
    }
  });
});

describe("withWorkspace", () => {
  const [{ owner: a, other: b }] = tenantPairs();

  test("a connection with no workspace cannot insert", async () => {
    await expectRlsViolation(bare.query(`insert into ${table} values ('x', '${a}', 'x')`));
  });

  test("the workspace setting does not survive the transaction on a reused connection", async () => {
    const single = createDatabase({ url: urls.rw, maxConnections: 1 });
    try {
      await single.withWorkspace(a, (tx) => tx.execute(sql`select 1`));
      const leaked = await single.withWorkspace(b, async (tx) => {
        const r = await tx.execute(sql`select current_setting('app.workspace_id', true) as ws`);
        return r.rows[0]?.["ws"];
      });
      expect(leaked).toBe(b);
      const outside = await single.withWorkspace(b, async (tx) => {
        const r = await tx.execute(sql.raw(`select count(*)::int as n from ${table} where workspace_id = '${a}'`));
        return r.rows[0]?.["n"];
      });
      expect(outside).toBe(0);
    } finally {
      await single.close();
    }
  });

  test("interleaved transactions for two workspaces each see only their own rows", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b)).map(async (ws) => ({ ws, rows: await rows(ws) })),
    );
    for (const r of results) for (const row of r.rows) expect(row.workspace_id).toBe(r.ws);
  });

  test("a thrown error rolls the transaction back", async () => {
    const id = `${a}:rolled-back`;
    await expect(
      db.withWorkspace(a, async (tx) => {
        await tx.execute(sql`insert into ${sql.identifier(table)} (id, workspace_id, body) values (${id}, ${a}, 'x')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await rows(a)).map((r) => r.id)).not.toContain(id);
  });

  test.each(["", "ws_short", "bot_01m7a256m0a13warwhczsjhx9g", "ws_01m7a256m03ekr5s35pwdea14m'; drop table x; --"])(
    "rejects workspace id %j before touching the database",
    async (bad) => {
      await expect(db.withWorkspace(bad, () => Promise.resolve(1))).rejects.toThrow(/workspace id/);
    },
  );
});
