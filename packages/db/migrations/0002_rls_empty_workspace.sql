-- 0002 (ADR-014): treat an empty app.workspace_id as unset.
--
-- After one transaction-local set_config, a pooled connection reports app.workspace_id as ''
-- rather than NULL. With the 0001 policy, a bare query on such a connection could read and write
-- rows whose workspace_id is ''. nullif turns '' into NULL, which matches nothing.

create or replace procedure app_internal.enable_tenant_rls(target regclass)
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
  execute format(
    $policy$
      create policy tenant_isolation on %s
        as permissive for all to public
        using (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
        with check (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
    $policy$,
    target
  );
end;
$$;

-- create or replace keeps the existing privileges, but say it again so the file reads on its own.
revoke all on procedure app_internal.enable_tenant_rls(regclass) from public;

-- Bring existing tenant tables to the new shape. None exist yet in the shipped migrations; this
-- covers any database where a later migration ran before this one was written.
do $$
declare
  t regclass;
begin
  for t in
    select p.polrelid::regclass from pg_policy p where p.polname = 'tenant_isolation'
  loop
    execute format(
      $policy$
        alter policy tenant_isolation on %s
          using (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
          with check (workspace_id = nullif(current_setting('app.workspace_id', true), ''))
      $policy$,
      t
    );
  end loop;
end;
$$;
