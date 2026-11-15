-- 0018 table storage (task 9.1, architecture §§2.3 and 10, ADR-004).
-- Foreign keys include workspace_id because PostgreSQL's integrity checks bypass RLS.

create table bot_tables (
  id text primary key check (id ~ '^tbl_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,47}$'),
  description text check (length(description) <= 500),
  columns jsonb not null check (jsonb_typeof(columns) = 'array' and jsonb_array_length(columns) between 1 and 50),
  row_count integer not null default 0 check (row_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (bot_id, name),
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('bot_tables');

create table table_rows (
  id text primary key check (id ~ '^row_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  table_id text not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  lex tsvector not null default ''::tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (table_id, workspace_id) references bot_tables (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('table_rows');
create index table_rows_table_idx on table_rows (table_id, id);
create index table_rows_lex_idx on table_rows using gin (lex);
