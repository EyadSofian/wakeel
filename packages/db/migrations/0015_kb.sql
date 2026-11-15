-- 0015 knowledge bases and files (task 8.1, architecture §2.3 and §8, ADR-007, ADR-039). Runs as
-- app_migrator.
--
-- Every table is tenant-owned with RLS forced. Children point at parents with composite foreign
-- keys that include workspace_id, because foreign keys skip RLS: a plain id would let one tenant
-- attach rows to another's knowledge base. Chunks hold a 1024-dimensional embedding (ADR-007 §1)
-- with an HNSW index fixed at creation (m = 16, ef_construction = 128) and a tsvector built by our
-- own normaliser (ADR-007 §2).

create table files (
  id text primary key check (id ~ '^file_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  bot_id text,
  purpose text not null check (purpose in ('kb_source')),
  name text not null check (length(name) between 1 and 255),
  -- ws/<workspace>/files/<id>: made by the api, never by a client (ADR-039 §4).
  key text not null unique,
  mime text not null check (length(mime) between 3 and 255),
  size bigint not null check (size > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_by text references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade,
  check (key = 'ws/' || workspace_id || '/files/' || id)
);
call app_internal.enable_tenant_rls('files');
create index files_pending_idx on files (created_at) where status = 'pending';

create table knowledge_bases (
  id text primary key check (id ~ '^kb_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  name text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 1000),
  embedding_model text not null check (length(embedding_model) between 3 and 200),
  embedding_dims integer not null default 1024 check (embedding_dims = 1024),
  index_version integer not null default 1 check (index_version >= 1),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (bot_id, name),
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('knowledge_bases');

create table kb_sources (
  id text primary key check (id ~ '^src_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  kb_id text not null,
  kind text not null check (kind in ('file', 'url', 'sitemap', 'crawl', 'text')),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  -- Re-sync interval for url, sitemap and crawl sources (8.5), for example '1 day'.
  schedule interval,
  status text not null default 'pending' check (status in ('pending', 'syncing', 'ready', 'failed')),
  last_synced_at timestamptz,
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (kb_id, workspace_id) references knowledge_bases (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('kb_sources');
create index kb_sources_kb_idx on kb_sources (kb_id, created_at);

create table kb_documents (
  id text primary key check (id ~ '^doc_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  kb_id text not null,
  source_id text not null,
  title text not null default '' check (length(title) <= 500),
  -- The file name, page URL or text label; unique within a source, so a re-sync finds its row.
  uri text not null check (length(uri) between 1 and 2048),
  mime text,
  lang text,
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Object key of the parsed Markdown (8.2).
  parsed_key text,
  status text not null default 'pending' check (status in ('pending', 'parsing', 'indexing', 'ready', 'failed')),
  token_count integer not null default 0 check (token_count >= 0),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (source_id, uri),
  foreign key (kb_id, workspace_id) references knowledge_bases (id, workspace_id) on delete cascade,
  foreign key (source_id, workspace_id) references kb_sources (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('kb_documents');
create index kb_documents_kb_idx on kb_documents (kb_id, created_at);

create table kb_chunks (
  id text primary key check (id ~ '^chk_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  kb_id text not null,
  document_id text not null,
  ordinal integer not null check (ordinal >= 0),
  heading_path text[] not null default '{}',
  text text not null,
  -- The normalised, light-stemmed form (packages/retrieval/src/arabic.ts); same function at query time.
  text_norm text not null,
  lex tsvector not null,
  embedding vector(1024),
  token_count integer not null check (token_count >= 0),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  index_version integer not null check (index_version >= 1),
  created_at timestamptz not null default now(),
  unique (document_id, index_version, ordinal),
  foreign key (kb_id, workspace_id) references knowledge_bases (id, workspace_id) on delete cascade,
  foreign key (document_id, workspace_id) references kb_documents (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('kb_chunks');
create index kb_chunks_embedding_idx on kb_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128);
create index kb_chunks_lex_idx on kb_chunks using gin (lex);
create index kb_chunks_kb_version_idx on kb_chunks (kb_id, index_version);

create table kb_ingestion_jobs (
  id text primary key check (id ~ '^ijob_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  kb_id text not null,
  source_id text not null,
  document_id text,
  stage text not null check (stage in ('fetch', 'parse', 'normalise', 'chunk', 'embed', 'index')),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (kb_id, workspace_id) references knowledge_bases (id, workspace_id) on delete cascade,
  foreign key (source_id, workspace_id) references kb_sources (id, workspace_id) on delete cascade,
  foreign key (document_id, workspace_id) references kb_documents (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('kb_ingestion_jobs');
create index kb_ingestion_jobs_doc_idx on kb_ingestion_jobs (document_id, stage);
