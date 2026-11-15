-- A live table mutation commits its recovery result atomically (ADR-048).
create table table_write_receipts (
  workspace_id text not null,
  conversation_id text not null,
  turn_id text not null,
  table_id text not null,
  step_seq integer not null check (step_seq > 0),
  call_ordinal integer not null check (call_ordinal > 0),
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (turn_id, step_seq, call_ordinal),
  foreign key (turn_id, conversation_id, workspace_id)
    references turns (id, conversation_id, workspace_id) on delete cascade,
  foreign key (table_id, workspace_id) references bot_tables (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('table_write_receipts');
create index table_write_receipts_table_idx on table_write_receipts (table_id);
