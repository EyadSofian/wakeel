-- 0012 bot versions (task 7.1, architecture §2.3 and §3, ADR-006, ADR-036). Runs as app_migrator.
--
-- A version is an immutable snapshot of the whole BotDefinition with a SHA-256 of its canonical
-- JSON. Publishing stores one and points bots.published_version_id at it; rollback moves only the
-- pointer. app_rw may insert and read versions but never change or delete them; they go with
-- their bot.

create table bot_versions (
  id text primary key check (id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  number integer not null check (number >= 1),
  label text not null check (length(label) between 1 and 80),
  notes text not null default '' check (length(notes) <= 2000),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  definition_hash text not null check (definition_hash ~ '^[0-9a-f]{64}$'),
  created_by text references users (id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  unique (bot_id, number),
  -- Target of bots.published_version_id: a bot can only point at one of its own versions.
  unique (id, bot_id),
  -- Composite, so a version can only belong to a bot in its own workspace (foreign keys skip RLS).
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('bot_versions');
create index bot_versions_bot_number_idx on bot_versions (bot_id, number desc);

revoke update, delete, truncate on bot_versions from app_rw;

alter table bots
  add constraint bots_published_version_fk
  foreign key (published_version_id, id) references bot_versions (id, bot_id)
  on delete set null (published_version_id);
