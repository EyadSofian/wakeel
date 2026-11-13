import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, test } from "vitest";
import {
  bootstrapDatabase,
  findRlsProblems,
  MIGRATIONS_DIR,
  MigrationError,
  migrate,
  STANDARD_POLICY_EXPRESSION,
} from "../src/index";
import { roleUrl } from "../src/testing/index";

const urls = inject("db");

const withClient = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

describe("the migrated schema", () => {
  test("every table with workspace_id has forced RLS and exactly the standard policy", async () => {
    expect(await withClient(urls.superuser, findRlsProblems)).toEqual([]);
  });

  test("the migrations table records each file with a checksum", async () => {
    const rows = await withClient(urls.migrator, async (c) => (await c.query("select * from schema_migrations")).rows);
    expect(rows[0]).toMatchObject({ version: 1, name: "foundation" });
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("findRlsProblems catches", () => {
  // Each case runs in a transaction that is rolled back, so the shared schema is untouched.
  const problemsAfter = (ddl: string) =>
    withClient(urls.migrator, async (c) => {
      await c.query("begin");
      try {
        await c.query(ddl);
        return await findRlsProblems(c);
      } finally {
        await c.query("rollback");
      }
    });

  test.each([
    ["RLS never enabled", "create table p1 (workspace_id text not null)", "rls_not_enabled"],
    [
      "RLS enabled but not forced",
      "create table p2 (workspace_id text not null); alter table p2 enable row level security",
      "rls_not_forced",
    ],
    [
      "a forced table with no policy",
      "create table p3 (workspace_id text not null); alter table p3 enable row level security; alter table p3 force row level security",
      "policy_missing",
    ],
    [
      "a policy that checks something else",
      `create table p4 (workspace_id text not null); alter table p4 enable row level security; alter table p4 force row level security;
       create policy tenant_isolation on p4 using (true) with check (true)`,
      "policy_not_standard",
    ],
    [
      "an extra permissive policy next to the standard one",
      `create table p5 (workspace_id text not null); call app_internal.enable_tenant_rls('p5');
       create policy everyone on p5 for select using (true)`,
      "policy_not_standard",
    ],
    [
      "a nullable workspace_id",
      "create table p6 (workspace_id text); call app_internal.enable_tenant_rls('p6')",
      "workspace_id_nullable",
    ],
    [
      "a workspace_id that is not text",
      "create table p7 (workspace_id uuid not null); alter table p7 enable row level security; alter table p7 force row level security",
      "workspace_id_not_text",
    ],
  ])("%s", async (_name, ddl, kind) => {
    const problems = await problemsAfter(ddl);
    expect(problems.map((p) => p.kind)).toContain(kind);
  });

  test("a table built with the helper has no problems", async () => {
    const problems = await problemsAfter(
      "create table ok1 (id text primary key, workspace_id text not null); call app_internal.enable_tenant_rls('ok1')",
    );
    expect(problems).toEqual([]);
  });

  test("the helper refuses a table without workspace_id", async () => {
    await expect(
      problemsAfter("create table nows (id text); call app_internal.enable_tenant_rls('nows')"),
    ).rejects.toThrow(/workspace_id/);
  });
});

describe("migrate", () => {
  // Each test gets its own database so runs never see each other's history.
  let dir: string;
  let dbName: string;
  let migratorUrl: string;

  const freshDatabase = async () => {
    dbName = `mig_${Math.random().toString(36).slice(2, 10)}`;
    await withClient(urls.superuser, (c) => c.query(`create database ${dbName}`));
    const superuser = roleUrl(urls.superuser, { database: dbName });
    await bootstrapDatabase(superuser, urls.passwords);
    migratorUrl = roleUrl(urls.migrator, { database: dbName });
  };

  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
  /** Recorded migrations; empty when the runner stopped before creating its table. */
  const applied = () =>
    withClient(migratorUrl, async (c) => {
      const exists = (await c.query("select to_regclass('schema_migrations') is not null as e")).rows[0].e;
      if (!exists) return [];
      return (await c.query("select version, name from schema_migrations order by version")).rows;
    });
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (e) {
      if (e instanceof MigrationError) return e;
      throw e;
    }
    throw new Error("expected a MigrationError");
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wakeel-mig-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => {
    for (const f of ["0001_a.sql", "0002_b.sql", "0003_c.sql", "0004_d.sql", "notes.sql", "0002_dup.sql"]) {
      rmSync(join(dir, f), { force: true });
    }
  });

  test("applies pending files in order, once", async () => {
    await freshDatabase();
    write("0001_a.sql", "create table a (id int);");
    write("0002_b.sql", "create table b (id int);");
    expect((await migrate(migratorUrl, { dir })).applied).toEqual(["0001_a", "0002_b"]);
    expect((await migrate(migratorUrl, { dir })).applied).toEqual([]);
    write("0003_c.sql", "create table c (id int);");
    expect((await migrate(migratorUrl, { dir })).applied).toEqual(["0003_c"]);
    expect(await applied()).toEqual([
      { version: 1, name: "a" },
      { version: 2, name: "b" },
      { version: 3, name: "c" },
    ]);
  });

  test("an edited migration that already ran stops the runner", async () => {
    await freshDatabase();
    write("0001_a.sql", "create table a (id int);");
    await migrate(migratorUrl, { dir });
    write("0001_a.sql", "create table a (id int, extra text);");
    const e = await failure(migrate(migratorUrl, { dir }));
    expect(e.code).toBe("checksum_mismatch");
    expect(e.message).toContain("0001_a.sql");
  });

  test("a failing migration is rolled back and not recorded", async () => {
    await freshDatabase();
    write("0001_a.sql", "create table a (id int);");
    write("0002_b.sql", "create table b (id int); select * from does_not_exist;");
    const e = await failure(migrate(migratorUrl, { dir }));
    expect(e.code).toBe("failed");
    expect(e.message).toMatch(/0002_b\.sql.*does_not_exist/s);
    expect(await applied()).toEqual([{ version: 1, name: "a" }]);
    const b = await withClient(migratorUrl, (c) => c.query("select to_regclass('b') as t"));
    expect(b.rows[0].t).toBeNull();
  });

  test("a tenant table without RLS is rolled back", async () => {
    await freshDatabase();
    write("0001_a.sql", "create table leaky (id text, workspace_id text not null);");
    const e = await failure(migrate(migratorUrl, { dir }));
    expect(e.code).toBe("tenant_table_without_rls");
    expect(e.message).toContain("leaky");
    expect(await applied()).toEqual([]);
  });

  test.each([
    ["a gap in numbering", ["0001_a.sql", "0003_c.sql"], "numbering"],
    ["a duplicate number", ["0001_a.sql", "0002_b.sql", "0002_dup.sql"], "numbering"],
    ["a file that does not follow NNNN_name.sql", ["0001_a.sql", "notes.sql"], "bad_file_name"],
  ])("%s stops the runner before anything runs", async (_name, files, code) => {
    await freshDatabase();
    for (const f of files) write(f, `create table x_${f.slice(0, 4)} (id int);`);
    const e = await failure(migrate(migratorUrl, { dir }));
    expect(e.code).toBe(code);
    expect(await applied()).toEqual([]);
  });

  test("a recorded migration whose file is gone stops the runner", async () => {
    await freshDatabase();
    write("0001_a.sql", "create table a (id int);");
    write("0002_b.sql", "create table b (id int);");
    await migrate(migratorUrl, { dir });
    rmSync(join(dir, "0002_b.sql"));
    expect((await failure(migrate(migratorUrl, { dir }))).code).toBe("missing_file");
  });

  test("two runners at once apply each migration exactly once", async () => {
    await freshDatabase();
    write("0001_a.sql", "create table a (id int); select pg_sleep(0.2);");
    write("0002_b.sql", "create table b (id int);");
    const [first, second] = await Promise.all([migrate(migratorUrl, { dir }), migrate(migratorUrl, { dir })]);
    expect([...first.applied, ...second.applied].sort()).toEqual(["0001_a", "0002_b"]);
  });

  test("refuses to run as any role but app_migrator", async () => {
    await freshDatabase();
    write("0001_a.sql", "create table a (id int);");
    const asSuperuser = roleUrl(urls.superuser, { database: dbName });
    expect((await failure(migrate(asSuperuser, { dir }))).code).toBe("wrong_role");
  });
});

describe("0002 (ADR-014) on a database that already has tenant tables", () => {
  test("rewrites their policies to the nullif form", async () => {
    const dbName = `adr14_${Math.random().toString(36).slice(2, 10)}`;
    await withClient(urls.superuser, (c) => c.query(`create database ${dbName}`));
    await bootstrapDatabase(roleUrl(urls.superuser, { database: dbName }), urls.passwords);
    const migratorUrl = roleUrl(urls.migrator, { database: dbName });

    // A database that only has 0001, with a tenant table made by 0001's version of the helper.
    const onlyFirst = mkdtempSync(join(tmpdir(), "wakeel-adr14-"));
    try {
      copyFileSync(join(MIGRATIONS_DIR, "0001_foundation.sql"), join(onlyFirst, "0001_foundation.sql"));
      await migrate(migratorUrl, { dir: onlyFirst });
    } finally {
      rmSync(onlyFirst, { recursive: true, force: true });
    }
    const policy = () =>
      withClient(migratorUrl, async (c) => {
        const { rows } = await c.query(
          "select pg_get_expr(polqual, polrelid) as using, pg_get_expr(polwithcheck, polrelid) as check from pg_policy where polrelid = 'legacy'::regclass",
        );
        return rows[0];
      });
    await withClient(migratorUrl, (c) =>
      c.query(
        "create table legacy (id text, workspace_id text not null); call app_internal.enable_tenant_rls('legacy')",
      ),
    );
    expect((await policy()).using).not.toContain("NULLIF");

    expect((await migrate(migratorUrl)).applied[0]).toBe("0002_rls_empty_workspace");
    expect(await policy()).toEqual({ using: STANDARD_POLICY_EXPRESSION, check: STANDARD_POLICY_EXPRESSION });
    expect(await withClient(migratorUrl, findRlsProblems)).toEqual([]);
  });
});
