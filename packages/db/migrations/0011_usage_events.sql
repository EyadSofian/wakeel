-- 0011 usage events (task 6.1, architecture §2 and §13, ADR-010). Runs as app_migrator.
--
-- One row per metered call: model tokens, embedding tokens (and later code time, storage). Range-
-- partitioned by month on `at`, like trace_spans (0008), with the same partition hardening: app_rw
-- gets the parent only, and every partition has RLS enabled and forced.
--
-- `mode` keeps emulator and eval traffic apart from live traffic; it is never billed (CLAUDE.md §9).
-- `detail` holds the token breakdown the cost was computed from, and the key's source.

create table usage_events (
  id text not null check (id ~ '^usg_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text,
  kind text not null check (kind in ('conversation', 'llm_tokens', 'embedding_tokens', 'rerank_units', 'code_ms',
    'kb_storage_bytes', 'table_rows', 'webhook_deliveries')),
  quantity numeric not null check (quantity >= 0),
  unit text not null check (unit in ('tokens', 'units', 'ms', 'bytes', 'rows', 'deliveries', 'conversations')),
  model text,
  cost_micro_usd bigint not null default 0 check (cost_micro_usd >= 0),
  mode text not null check (mode in ('live', 'emulator', 'eval')),
  conversation_id text,
  turn_id text,
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  at timestamptz not null default now(),
  primary key (id, at),
  foreign key (workspace_id) references workspaces (id) on delete cascade
) partition by range (at);

create index usage_events_workspace_at_idx on usage_events (workspace_id, at);

do $$
declare
  month date := date '2026-11-01';
begin
  while month < date '2027-07-01' loop
    execute format('create table %I partition of usage_events for values from (%L) to (%L)',
      format('usage_events_%s', to_char(month, 'YYYY_MM')), month, month + interval '1 month');
    month := month + interval '1 month';
  end loop;
end
$$;
create table usage_events_default partition of usage_events default;

call app_internal.enable_tenant_rls('usage_events');

do $$
declare
  part regclass;
begin
  for part in select inhrelid::regclass from pg_inherits where inhparent = 'usage_events'::regclass loop
    execute format('revoke all on %s from app_rw', part);
    call app_internal.enable_tenant_rls(part);
  end loop;
end
$$;
