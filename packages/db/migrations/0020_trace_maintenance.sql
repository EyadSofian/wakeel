-- ADR-049. This queue is populated in the same scoped transaction that removes trace metadata.
create table trace_payload_deletions (
  workspace_id text not null references workspaces (id) on delete cascade,
  payload_key text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, payload_key)
);
call app_internal.enable_tenant_rls('trace_payload_deletions');

create index trace_spans_retention_idx on trace_spans (workspace_id, started_at);

create schema trace_maintenance;
revoke all on schema trace_maintenance from public;
grant usage on schema trace_maintenance to app_rw;

-- The worker can request current/next UTC partitions. It cannot supply table names or DDL.
create function trace_maintenance.prepare_trace_partitions() returns void
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  month_start date := date_trunc('month', now() at time zone 'UTC');
  month_end date;
  part text;
  ws text;
  original_scope text := current_setting('app.workspace_id', true);
begin
  for offset_month in 0..1 loop
    month_end := (month_start + interval '1 month')::date;
    part := format('trace_spans_%s', to_char(month_start, 'YYYY_MM'));
    if to_regclass(format('public.%I', part)) is null then
      lock table public.trace_spans in access exclusive mode;
      if to_regclass(format('public.%I', part)) is null then
        execute format('create table public.%I (like public.trace_spans including defaults including constraints)', part);
        -- The owner is still subject to FORCE RLS on the default partition. Move one tenant at a time.
        for ws in select id from public.workspaces loop
          perform set_config('app.workspace_id', ws, true);
          execute format('with moved as (
            delete from public.trace_spans_default
            where workspace_id = $1 and started_at >= $2 and started_at < $3 returning *)
            insert into public.%I select * from moved', part)
          using ws, (month_start::timestamp at time zone 'UTC'), (month_end::timestamp at time zone 'UTC');
        end loop;
        execute format('alter table public.trace_spans attach partition public.%I for values from (%L) to (%L)',
          part, month_start || 'T00:00:00+00:00', month_end || 'T00:00:00+00:00');
        execute format('revoke all on public.%I from app_rw', part);
        call app_internal.enable_tenant_rls(to_regclass(format('public.%I', part)));
      end if;
    end if;
    month_start := month_end;
  end loop;
  perform set_config('app.workspace_id', coalesce(original_scope, ''), true);
end
$$;
revoke all on function trace_maintenance.prepare_trace_partitions() from public;
grant execute on function trace_maintenance.prepare_trace_partitions() to app_rw;

-- Drop an old partition only after every tenant's visible slice is empty.
create function trace_maintenance.drop_empty_trace_partition() returns void
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  part text;
  ws text;
  populated boolean;
  original_scope text := current_setting('app.workspace_id', true);
begin
  select c.relname into part
    from pg_catalog.pg_inherits i join pg_catalog.pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.trace_spans'::regclass
      and c.relname ~ '^trace_spans_[0-9]{4}_(0[1-9]|1[012])$'
      and to_date(right(c.relname, 7) || '_01', 'YYYY_MM_DD') + interval '1 month'
        <= (now() at time zone 'UTC') - interval '30 days'
    order by c.relname limit 1;
  if part is null then return; end if;
  lock table public.trace_spans in access exclusive mode;
  if to_regclass(format('public.%I', part)) is null then return; end if;
  for ws in select id from public.workspaces loop
    perform set_config('app.workspace_id', ws, true);
    execute format('select exists(select 1 from public.%I where workspace_id = $1)', part)
      into populated using ws;
    if populated then
      perform set_config('app.workspace_id', coalesce(original_scope, ''), true);
      return;
    end if;
  end loop;
  execute format('drop table public.%I', part);
  perform set_config('app.workspace_id', coalesce(original_scope, ''), true);
end
$$;
revoke all on function trace_maintenance.drop_empty_trace_partition() from public;
grant execute on function trace_maintenance.drop_empty_trace_partition() to app_rw;
