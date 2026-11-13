import pg from "pg";
import { describe, expect, inject, test } from "vitest";
import { bootstrapDatabase, createDatabase } from "../src/index";
import { sql } from "../src/sql";
import { tenantPairs } from "../src/testing/index";

const urls = inject("db");

const query = async (url: string, text: string) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
};

describe("roles", () => {
  test.each(["app_migrator", "app_rw", "app_admin_ro"])("%s cannot bypass RLS or manage roles", async (role) => {
    const { rows } = await query(
      urls.superuser,
      `select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = '${role}'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
  });

  test("app_rw cannot run DDL", async () => {
    await expect(query(urls.rw, "create table rw_ddl (id int)")).rejects.toThrow(/permission denied/);
  });

  test("app_rw cannot read the migrations table", async () => {
    await expect(query(urls.rw, "select * from schema_migrations")).rejects.toThrow(/permission denied/);
  });

  test("app_rw cannot call the RLS helper", async () => {
    await expect(query(urls.rw, "call app_internal.enable_tenant_rls('x')")).rejects.toThrow(/permission denied/);
  });

  test("new tables get DML for app_rw and read-only for app_admin_ro", async () => {
    await query(
      urls.migrator,
      "create table grants_probe (id text primary key, workspace_id text not null); call app_internal.enable_tenant_rls('grants_probe')",
    );
    const [{ owner }] = tenantPairs();
    const rw = createDatabase({ url: urls.rw });
    try {
      await rw.withWorkspace(owner, (tx) => tx.execute(sql`insert into grants_probe values ('g1', ${owner})`));
    } finally {
      await rw.close();
    }
    await expect(query(urls.adminRo, "insert into grants_probe values ('g2', 'ws_x')")).rejects.toThrow(
      /permission denied/,
    );
    // Read-only, and still bound by RLS: with no workspace set it sees nothing.
    expect((await query(urls.adminRo, "select count(*)::int as n from grants_probe")).rows[0].n).toBe(0);
  });

  test("bootstrap can run again without changing anything", async () => {
    await bootstrapDatabase(urls.superuser, urls.passwords);
    await bootstrapDatabase(urls.superuser, urls.passwords);
    expect((await query(urls.rw, "select current_user as u")).rows[0].u).toBe("app_rw");
  });
});

describe("Database.verify", () => {
  test("accepts app_rw", async () => {
    const db = createDatabase({ url: urls.rw });
    try {
      await expect(db.verify()).resolves.toEqual({ role: "app_rw" });
    } finally {
      await db.close();
    }
  });

  test("refuses a role that bypasses RLS", async () => {
    const db = createDatabase({ url: urls.superuser });
    try {
      await expect(db.verify()).rejects.toThrow(/bypass row-level security/);
    } finally {
      await db.close();
    }
  });
});
