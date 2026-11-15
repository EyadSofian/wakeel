-- 0008 trace spans (task 4.7, architecture §12, ADR-009, ADR-026). Runs as app_migrator.
--
-- Span metadata, range-partitioned by month on started_at. A partitioned table's primary key must
-- include the partition key, so it is (id, started_at); span ids are unique on their own anyway
-- (derived from the turn and seq, ADR-026).
--
-- Row-level security: queries through the parent use the parent's policy, but a partition read
-- directly does not, so app_rw gets the parent only (the default privileges from 0001 would grant
-- each partition too) and every partition also has RLS enabled and forced, in case a grant ever
-- slips through.
--
-- Months from 2026-11 to 2027-06 exist, plus a default partition for anything outside them.
-- Creating months ahead and dropping old ones is retention work (Phase 10).

create table trace_spans (
  id text not null check (id ~ '^span_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  conversation_id text not null,
  turn_id text not null check (turn_id ~ '^turn_[0-9a-hjkmnp-tv-z]{26}$'),
  parent_id text check (parent_id ~ '^span_[0-9a-hjkmnp-tv-z]{26}$'),
  -- Order within the turn.
  seq integer not null check (seq >= 0),
  kind text not null check (kind in ('turn', 'node', 'card', 'autonomy.iteration', 'llm.call', 'code.exec',
    'tool.call', 'kb.search', 'table.op', 'webhook.delivery', 'error')),
  name text not null check (length(name) <= 200),
  status text not null check (status in ('ok', 'error')),
  started_at timestamptz not null,
  duration_ms integer not null check (duration_ms >= 0),
  -- Where in the definition: { workflowId?, nodeId?, cardId?, toolId? }.
  location jsonb not null default '{}' check (jsonb_typeof(location) = 'object'),
  attrs jsonb not null default '{}' check (jsonb_typeof(attrs) = 'object'),
  -- Object-store key of a payload over 8 KB (ADR-009); unused until large payloads exist.
  payload_key text,
  primary key (id, started_at),
  foreign key (conversation_id, workspace_id) references conversations (id, workspace_id) on delete cascade
) partition by range (started_at);

create index trace_spans_turn_idx on trace_spans (turn_id, seq);

do $$
declare
  month date := date '2026-11-01';
  name text;
begin
  while month < date '2027-07-01' loop
    name := format('trace_spans_%s', to_char(month, 'YYYY_MM'));
    execute format('create table %I partition of trace_spans for values from (%L) to (%L)',
      name, month, month + interval '1 month');
    month := month + interval '1 month';
  end loop;
end
$$;
create table trace_spans_default partition of trace_spans default;

call app_internal.enable_tenant_rls('trace_spans');

do $$
declare
  part regclass;
begin
  for part in select inhrelid::regclass from pg_inherits where inhparent = 'trace_spans'::regclass loop
    execute format('revoke all on %s from app_rw', part);
    call app_internal.enable_tenant_rls(part);
  end loop;
end
$$;
