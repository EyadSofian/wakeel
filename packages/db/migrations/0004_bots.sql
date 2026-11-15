-- 0004 bots (task 2.1, architecture §2.3 "Bot definition", §3, ADR-006). Runs as app_migrator.
--
-- A bot's draft is one manifest document plus one document per workflow, each with an integer
-- revision. Saves replace the whole document when the caller's revision matches (If-Match).

create table bots (
  id text primary key check (id ~ '^bot_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
  default_locale text not null default 'ar' check (default_locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  -- Foreign key arrives with bot_versions (7.1).
  published_version_id text check (published_version_id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug),
  -- Target of the composite foreign key below.
  unique (id, workspace_id)
);
call app_internal.enable_tenant_rls('bots');
create index bots_workspace_created_idx on bots (workspace_id, created_at desc, id desc);

create table bot_draft_docs (
  workspace_id text not null,
  bot_id text not null,
  kind text not null check (kind in ('manifest', 'workflow')),
  doc_id text not null,
  rev integer not null check (rev >= 0),
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  updated_by text references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bot_id, kind, doc_id),
  -- Composite, so a document can only point at a bot in its own workspace. Foreign key checks do
  -- not apply RLS; a plain bot_id key would let another tenant attach documents to a known bot id.
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade,
  check ((kind = 'manifest') = (doc_id = 'manifest')),
  check (kind = 'manifest' or doc_id ~ '^wf_[0-9A-Za-z]{10}$')
);
call app_internal.enable_tenant_rls('bot_draft_docs');
