import { sql } from "drizzle-orm";

/**
 * The workspace id set by `withWorkspace` for the current transaction, as a SQL expression. Use it
 * to filter platform tables (which have no RLS) by the scoped workspace instead of trusting an id
 * from the caller. Empty or unset matches nothing (ADR-014).
 */
export const currentWorkspace = sql<string>`nullif(current_setting('app.workspace_id', true), '')`;
