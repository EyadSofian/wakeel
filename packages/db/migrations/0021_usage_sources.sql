-- A retried platform mutation must not emit its accounting event twice.
create table usage_sources (
  workspace_id text not null references workspaces (id) on delete cascade,
  source_key text not null,
  usage_id text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, source_key)
);
call app_internal.enable_tenant_rls('usage_sources');
