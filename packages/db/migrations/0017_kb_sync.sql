-- 0017 scheduled re-sync of knowledge base sources (task 8.5, ADR-042). Runs as app_migrator.
--
-- The maintenance job finds sources whose schedule is due across every workspace. It needs ids only,
-- so it uses a security definer lookup owned by app_lookup (ADR-015 pattern), never BYPASSRLS on
-- the application role.

grant select (id, workspace_id, kind, schedule, status, last_synced_at, updated_at) on kb_sources to app_lookup;

create function lookup.kb_sources_due(p_now timestamptz, p_limit integer)
returns table (source_id text, workspace_id text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select s.id, s.workspace_id
  from public.kb_sources s
  where s.schedule is not null
    and s.kind in ('url', 'sitemap', 'crawl')
    -- A sync that has been running for an hour is assumed dead and may start again.
    and (s.status <> 'syncing' or s.updated_at < p_now - interval '1 hour')
    and (s.last_synced_at is null or s.last_synced_at + s.schedule <= p_now)
  order by s.last_synced_at nulls first
  limit p_limit
$$;

revoke all on function lookup.kb_sources_due(timestamptz, integer) from public;
grant execute on function lookup.kb_sources_due(timestamptz, integer) to app_rw;
alter function lookup.kb_sources_due(timestamptz, integer) owner to app_lookup;
