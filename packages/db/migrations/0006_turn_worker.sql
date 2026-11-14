-- 0006 turn worker (task 4.4, architecture §4.2–4.4, ADR-008). Runs as app_migrator.
--
-- 1. The transcript's order. messages.seq must be strictly increasing per conversation, and two
--    writers add messages: the Bridge API (user messages, task 4.5) and the turn worker (bot
--    messages). One sequence serves both, so they never collide and no counter row is locked.
--    Numbers have gaps; only their order matters.
--
-- 2. Lookups for the turn worker and its janitor (ADR-015 pattern: security definer, owned by
--    app_lookup, ids only). A `turn` job carries only the conversation id (ADR-008), and the janitor
--    scans every workspace, so both need to find conversations before a workspace is known. They read
--    the rows themselves afterwards, under withWorkspace.

create sequence messages_seq as bigint;
alter table messages alter column seq set default nextval('messages_seq');
grant usage on sequence messages_seq to app_rw;

grant select (id, workspace_id, status, lease_until, expires_at, ended_at) on conversations to app_lookup;
grant select (conversation_id, kind, processed_at) on inbound_events to app_lookup;

-- Conversation id → its workspace, for a `turn` job.
create function lookup.conversation_workspace(p_conversation_id text)
returns text
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select c.workspace_id from public.conversations c where c.id = p_conversation_id
$$;

-- Conversations with unprocessed inbound events and no live lease: a lost `turn` job, or a worker
-- that died. The janitor enqueues a turn for each.
create function lookup.conversations_to_wake(p_limit integer)
returns table (conversation_id text, workspace_id text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select c.id, c.workspace_id
  from public.conversations c
  where (c.lease_until is null or c.lease_until < now())
    and exists (select 1 from public.inbound_events e where e.conversation_id = c.id and e.processed_at is null)
  order by c.id
  limit p_limit
$$;

-- Waiting conversations past their inactivity deadline with no timeout event pending. Only waiting
-- conversations: the engine's event table gives `timeout` meaning only there (§4.4).
create function lookup.conversations_expired(p_limit integer)
returns table (conversation_id text, workspace_id text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select c.id, c.workspace_id
  from public.conversations c
  where c.expires_at < now()
    and c.ended_at is null
    and c.status in ('waiting_input', 'waiting_external')
    and not exists (
      select 1 from public.inbound_events e
      where e.conversation_id = c.id and e.kind = 'timeout' and e.processed_at is null
    )
  order by c.expires_at
  limit p_limit
$$;

revoke all on function lookup.conversation_workspace(text) from public;
revoke all on function lookup.conversations_to_wake(integer) from public;
revoke all on function lookup.conversations_expired(integer) from public;

grant execute on function lookup.conversation_workspace(text) to app_rw;
grant execute on function lookup.conversations_to_wake(integer) to app_rw;
grant execute on function lookup.conversations_expired(integer) to app_rw;

-- Last: after this app_migrator no longer owns the functions and cannot change their grants.
alter function lookup.conversation_workspace(text) owner to app_lookup;
alter function lookup.conversations_to_wake(integer) owner to app_lookup;
alter function lookup.conversations_expired(integer) owner to app_lookup;
