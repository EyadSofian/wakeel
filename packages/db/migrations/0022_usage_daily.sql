-- Daily usage preserves mode and unattributed utility calls. A null model/bot still identifies
-- one group, so a retry cannot multiply its roll-up.
create table usage_daily (
  workspace_id text not null references workspaces (id) on delete cascade,
  day date not null,
  bot_id text,
  kind text not null check (kind in ('conversation', 'llm_tokens', 'embedding_tokens', 'rerank_units',
    'code_ms', 'kb_storage_bytes', 'table_rows', 'webhook_deliveries')),
  model text,
  mode text not null check (mode in ('live', 'emulator', 'eval')),
  quantity numeric not null check (quantity >= 0),
  cost_micro_usd bigint not null check (cost_micro_usd >= 0),
  unique nulls not distinct (workspace_id, day, bot_id, kind, model, mode)
);
call app_internal.enable_tenant_rls('usage_daily');
