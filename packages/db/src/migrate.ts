import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { findRlsProblems } from "./rls";
import { ROLES } from "./roles";

/** `packages/db/migrations`: hand-written, forward-only SQL (CLAUDE.md §6). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Arbitrary constant: only one runner per database at a time. */
const ADVISORY_LOCK_KEY = 727_384_001;

export type MigrationErrorCode =
  | "wrong_role"
  | "bad_file_name"
  | "numbering"
  | "missing_file"
  | "checksum_mismatch"
  | "failed"
  | "tenant_table_without_rls";

/** Why the runner stopped. Nothing after the failing migration has run. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
  }
}

interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  /** `NNNN_name` of each migration applied by this run, in order. */
  applied: string[];
}

export interface MigrateOptions {
  dir?: string;
}

/**
 * Applies pending migrations from `dir` as app_migrator. Each file runs in its own transaction
 * together with its record in `schema_migrations`; after it runs, every tenant table must pass
 * `findRlsProblems` or the transaction is rolled back. Files already applied must be unchanged
 * (sha256), so history cannot be rewritten.
 */
export async function migrate(migratorUrl: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const files = readMigrations(dir);

  const client = new pg.Client({ connectionString: migratorUrl, application_name: "wakeel-migrate" });
  await client.connect();
  try {
    const role = (await client.query("select current_user as u")).rows[0].u as string;
    if (role !== ROLES.migrator) {
      throw new MigrationError(
        "wrong_role",
        `Migrations must run as ${ROLES.migrator}, not ${role}, so that it owns every object. Use the migrator connection string.`,
      );
    }

    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          version int primary key,
          name text not null,
          checksum text not null,
          applied_at timestamptz not null default now()
        )`);
      await client.query("revoke all on schema_migrations from public");

      const done = new Map<number, { name: string; checksum: string }>();
      for (const row of (await client.query("select version, name, checksum from schema_migrations")).rows) {
        done.set(row.version, { name: row.name, checksum: row.checksum });
      }

      for (const [version, record] of done) {
        const file = files.find((f) => f.version === version);
        const label = `${String(version).padStart(4, "0")}_${record.name}.sql`;
        if (!file) {
          throw new MigrationError(
            "missing_file",
            `${label} was applied to this database but is no longer in ${dir}. Restore it; migrations are never deleted.`,
          );
        }
        if (file.checksum !== record.checksum) {
          throw new MigrationError(
            "checksum_mismatch",
            `${file.file} changed after it was applied. Revert the edit and put the change in a new migration.`,
          );
        }
      }

      const applied: string[] = [];
      for (const m of files) {
        if (done.has(m.version)) continue;
        await client.query("begin");
        try {
          await client.query(m.sql);
          const problems = await findRlsProblems(client);
          if (problems.length > 0) {
            throw new MigrationError(
              "tenant_table_without_rls",
              `${m.file} leaves tenant tables without the standard policy: ${problems
                .map((p) => `${p.table} (${p.detail})`)
                .join("; ")}. Call app_internal.enable_tenant_rls('<table>') in the same migration.`,
            );
          }
          await client.query("insert into schema_migrations (version, name, checksum) values ($1, $2, $3)", [
            m.version,
            m.name,
            m.checksum,
          ]);
          await client.query("commit");
          applied.push(`${String(m.version).padStart(4, "0")}_${m.name}`);
        } catch (e) {
          await client.query("rollback");
          if (e instanceof MigrationError) throw e;
          const message = e instanceof Error ? e.message : String(e);
          throw new MigrationError("failed", `${m.file} failed and was rolled back: ${message}`, { cause: e });
        }
      }
      return { applied };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

function readMigrations(dir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const match = FILE_NAME.exec(file);
    if (!match) {
      throw new MigrationError("bad_file_name", `${file} does not match NNNN_name.sql (lower-case name). Rename it.`);
    }
    const sql = readFileSync(join(dir, file), "utf8");
    files.push({
      version: Number(match[1]),
      name: match[2] ?? "",
      file,
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  files.forEach((f, i) => {
    if (f.version !== i + 1) {
      throw new MigrationError(
        "numbering",
        `${f.file} should be number ${String(i + 1).padStart(4, "0")}. Migrations are numbered 0001 upwards with no gaps or repeats.`,
      );
    }
  });
  return files;
}
