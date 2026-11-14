-- 0009 webhook deliveries (task 5.2, architecture §2, §9.2, ADR-005, ADR-028). Runs as app_migrator.
--
-- One row per attempt. A delivery is created as a pending attempt 1 in the transaction that writes
-- its outbox row (appendOutbox); an attempt becomes delivered, failed or dead, and a failed one with
-- schedule left is followed by a pending attempt n+1. The head of a conversation's stream is its
-- lowest-seq pending ordered row; a sender leases that row (lease_until) for the HTTP call instead
-- of holding a transaction open.

-- Composite foreign keys keep a delivery from naming another tenant's event (foreign key checks do
-- not apply RLS).
alter table outbox_events add unique (id, workspace_id);

create table webhook_deliveries (
  id text primary key check (id ~ '^dlv_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  connection_id text not null,
  conversation_id text not null,
  outbox_event_id text not null,
  -- Copied from the outbox row so the stream's head is found without a join: null for ephemeral.
  seq bigint check (seq >= 1),
  ephemeral boolean not null,
  -- No upper bound: a replay (task 5.3) adds attempts after the dead one.
  attempt integer not null check (attempt >= 1),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'dead')),
  next_attempt_at timestamptz not null,
  -- A sender holds the pending head while its HTTP call is in flight (ADR-028 §3).
  lease_until timestamptz,
  attempted_at timestamptz,
  response_status integer check (response_status between 100 and 599),
  -- { code, detail? } with a code from errors.ts (ADR-028 §10).
  error jsonb check (error is null or (jsonb_typeof(error) = 'object' and error ? 'code')),
  duration_ms integer check (duration_ms >= 0),
  created_at timestamptz not null default now(),
  check ((seq is null) = ephemeral),
  check (status = 'pending' or attempted_at is not null),
  unique (outbox_event_id, attempt),
  foreign key (outbox_event_id, workspace_id) references outbox_events (id, workspace_id) on delete cascade,
  foreign key (conversation_id, connection_id, workspace_id)
    references conversations (id, connection_id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('webhook_deliveries');

-- §2: the index that is easy to forget.
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
-- The head of one stream, and the Deliveries tab (5.5).
create index webhook_deliveries_stream_idx on webhook_deliveries (conversation_id, seq) where status = 'pending';
create index webhook_deliveries_connection_idx on webhook_deliveries (connection_id, created_at desc, id desc);

-- Conversations with a due, unleased pending delivery on an active connection: a lost `webhook`
-- job, a retry whose delayed job was lost, or a sender that died holding the lease. The janitor
-- enqueues a `webhook` job for each. Returns ids only.
-- app_lookup (bypassrls, no login) reads only the columns the function needs.
grant select (conversation_id, workspace_id, connection_id, status, next_attempt_at, lease_until)
  on webhook_deliveries to app_lookup;
grant select (id, status) on bridge_connections to app_lookup;

create function lookup.webhook_streams_due(p_now timestamptz, p_limit integer)
returns table (conversation_id text, workspace_id text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select distinct d.conversation_id, d.workspace_id
  from public.webhook_deliveries d
  join public.bridge_connections c on c.id = d.connection_id
  where d.status = 'pending'
    and d.next_attempt_at <= p_now
    and (d.lease_until is null or d.lease_until < p_now)
    and c.status = 'active'
  order by d.conversation_id
  limit p_limit
$$;

revoke all on function lookup.webhook_streams_due(timestamptz, integer) from public;
grant execute on function lookup.webhook_streams_due(timestamptz, integer) to app_rw;
-- Last: after this app_migrator no longer owns the function and cannot change its grants.
alter function lookup.webhook_streams_due(timestamptz, integer) owner to app_lookup;
