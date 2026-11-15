-- 0001 foundation (task 0.5, ADR-004, architecture §2.1). Runs as app_migrator.
--
-- 1. The one way to make a table tenant-owned: app_internal.enable_tenant_rls(table).
-- 2. Default privileges, so every table app_migrator creates is usable by app_rw (data only,
--    no DDL) and readable by app_admin_ro, without per-migration grants.
-- 3. New functions are not executable by everyone: security definer lookups (Phase 1) must be
--    granted to app_rw explicitly, one by one.

create schema app_internal;
revoke all on schema app_internal from public;

-- Enables and forces RLS on `target` and creates the standard policy. Every tenant table calls this
-- in the migration that creates it; the migration runner rejects any tenant table that does not
-- end up in exactly this state.
create procedure app_internal.enable_tenant_rls(target regclass)
language plpgsql
as $$
begin
  if not exists (
    select 1 from pg_attribute
    where attrelid = target and attname = 'workspace_id' and attnum > 0 and not attisdropped
  ) then
    raise exception 'Table % has no workspace_id column; add "workspace_id text not null" first', target;
  end if;

  execute format('alter table %s enable row level security', target);
  execute format('alter table %s force row level security', target);
  -- current_setting(..., true) returns NULL when unset, so a connection that never called
  -- withWorkspace matches no rows and cannot insert any: failing closed is the default.
  execute format(
    $policy$
      create policy tenant_isolation on %s
        as permissive for all to public
        using (workspace_id = current_setting('app.workspace_id', true))
        with check (workspace_id = current_setting('app.workspace_id', true))
    $policy$,
    target
  );
end;
$$;

revoke all on procedure app_internal.enable_tenant_rls(regclass) from public;

alter default privileges for role app_migrator in schema public
  grant select, insert, update, delete on tables to app_rw;
alter default privileges for role app_migrator in schema public
  grant usage, select on sequences to app_rw;
alter default privileges for role app_migrator in schema public
  grant select on tables to app_admin_ro;
alter default privileges for role app_migrator
  revoke execute on functions from public;
