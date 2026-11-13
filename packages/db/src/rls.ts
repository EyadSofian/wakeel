/** Anything that can run a query: a `pg.Client`, a `pg.PoolClient` or a `pg.Pool`. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string): Promise<{ rows: R[] }>;
}

export type RlsProblemKind =
  | "rls_not_enabled"
  | "rls_not_forced"
  | "workspace_id_not_text"
  | "workspace_id_nullable"
  | "policy_missing"
  | "policy_not_standard";

export interface RlsProblem {
  table: string;
  kind: RlsProblemKind;
  detail: string;
}

/** The expression Postgres stores for the standard policy, as `pg_get_expr` prints it. */
export const STANDARD_POLICY_EXPRESSION = "(workspace_id = current_setting('app.workspace_id'::text, true))";
export const STANDARD_POLICY_NAME = "tenant_isolation";

interface Row extends Record<string, unknown> {
  table: string;
  enabled: boolean;
  forced: boolean;
  type: string;
  not_null: boolean;
  policies: {
    name: string;
    cmd: string;
    permissive: boolean;
    roles: string[];
    using: string | null;
    check: string | null;
  }[];
}

/**
 * Lists every table (and partition) with a `workspace_id` column that is not in the state ADR-004
 * requires: RLS enabled and forced, `workspace_id text not null`, and exactly one policy, the
 * standard one. An empty list means tenant isolation holds for the whole schema.
 *
 * Used by the migration runner after every migration and by the migration test.
 */
export async function findRlsProblems(client: Queryable): Promise<RlsProblem[]> {
  const { rows } = await client.query<Row>(`
    select c.oid::regclass::text as "table",
           c.relrowsecurity as enabled,
           c.relforcerowsecurity as forced,
           format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as not_null,
           coalesce((
             select json_agg(json_build_object(
               'name', p.polname,
               'cmd', p.polcmd,
               'permissive', p.polpermissive,
               'roles', (select array_agg(case when r = 0 then 'public' else r::regrole::text end) from unnest(p.polroles) r),
               'using', pg_get_expr(p.polqual, p.polrelid),
               'check', pg_get_expr(p.polwithcheck, p.polrelid)
             ) order by p.polname)
             from pg_policy p where p.polrelid = c.oid
           ), '[]'::json) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id' and a.attnum > 0 and not a.attisdropped
    where c.relkind in ('r', 'p')
      and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg\\_toast%'
    order by 1
  `);

  const problems: RlsProblem[] = [];
  for (const t of rows) {
    const add = (kind: RlsProblemKind, detail: string) => problems.push({ table: t.table, kind, detail });
    if (!t.enabled) add("rls_not_enabled", "row level security is not enabled");
    else if (!t.forced) add("rls_not_forced", "row level security is not forced, so the table owner bypasses it");
    if (t.type !== "text") add("workspace_id_not_text", `workspace_id is ${t.type}, expected text`);
    if (!t.not_null) add("workspace_id_nullable", "workspace_id allows NULL");

    if (t.policies.length === 0) {
      if (t.enabled) add("policy_missing", "no policy, so no tenant can read or write it");
      continue;
    }
    const standard = t.policies.filter(
      (p) =>
        p.name === STANDARD_POLICY_NAME &&
        p.cmd === "*" &&
        p.permissive &&
        p.roles.length === 1 &&
        p.roles[0] === "public" &&
        p.using === STANDARD_POLICY_EXPRESSION &&
        p.check === STANDARD_POLICY_EXPRESSION,
    );
    if (standard.length !== 1 || t.policies.length !== 1) {
      add(
        "policy_not_standard",
        `expected only the ${STANDARD_POLICY_NAME} policy from app_internal.enable_tenant_rls; found ${t.policies
          .map((p) => p.name)
          .join(", ")}`,
      );
    }
  }
  return problems;
}
