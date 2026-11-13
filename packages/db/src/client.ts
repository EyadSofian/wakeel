import type { Secret } from "@wakeel/config";
import { WorkspaceId } from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import pg from "pg";

/** The transaction handed to `withWorkspace` callbacks: a Drizzle transaction scoped to one workspace. */
export type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

export interface DatabaseOptions {
  /** app_rw connection string (`DATABASE_URL`). */
  url: string | Secret<string>;
  maxConnections?: number;
  applicationName?: string;
  /** Errors on idle pooled connections (for example a server restart). Defaults to stderr. */
  onIdleError?: (error: Error) => void;
}

export interface Database {
  /**
   * The only way to run a tenant query (ADR-004). Opens a transaction, sets `app.workspace_id`
   * for that transaction only, runs `fn`, and commits; any error rolls back. RLS limits every
   * statement in `fn` to `workspaceId`'s rows.
   */
  withWorkspace<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>, config?: PgTransactionConfig): Promise<T>;
  /**
   * Checks the connected role cannot bypass row-level security. Services call this at boot and
   * refuse to start if it throws.
   */
  verify(): Promise<{ role: string }>;
  close(): Promise<void>;
}

/** Opens a pool for the app_rw role. The pool itself is never exposed. */
export function createDatabase(options: DatabaseOptions): Database {
  const url = typeof options.url === "string" ? options.url : options.url.reveal();
  const pool = new pg.Pool({
    connectionString: url,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? "wakeel",
  });
  const onIdleError =
    options.onIdleError ?? ((e: Error) => process.stderr.write(`Idle database connection failed: ${e.message}\n`));
  pool.on("error", onIdleError);
  const db = drizzle({ client: pool });

  return {
    async withWorkspace(workspaceId, fn, config) {
      if (!WorkspaceId.safeParse(workspaceId).success) {
        throw new TypeError("withWorkspace needs a valid workspace id (ws_ followed by 26 characters).");
      }
      return db.transaction(async (tx) => {
        // `true` makes the setting local to this transaction, so a pooled connection never carries it over.
        await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
        return fn(tx);
      }, config);
    },

    async verify() {
      const result = await pool.query(
        "select current_user as role, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      );
      const row = result.rows[0] as { role: string; rolsuper: boolean; rolbypassrls: boolean };
      if (row.rolsuper || row.rolbypassrls) {
        throw new Error(
          `The database role ${row.role} can bypass row-level security. Connect as app_rw (DATABASE_URL), never as a superuser.`,
        );
      }
      return { role: row.role };
    },

    async close() {
      await pool.end();
    },
  };
}
