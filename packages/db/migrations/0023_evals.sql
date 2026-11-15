-- Eval connections carry no public credential or outbound webhook.
alter table bridge_connections add column eval_internal boolean not null default false;
alter table bridge_connections add constraint eval_connection_is_internal check (
  not eval_internal or (target = 'draft' and webhook_url is null and emulator_session_id is null)
);

create table eval_suites (
  id text primary key check (id ~ '^es_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  name text not null check (length(name) between 1 and 80),
  revision integer not null default 1 check (revision > 0),
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade,
  unique (id, bot_id, workspace_id)
);
call app_internal.enable_tenant_rls('eval_suites');
create index eval_suites_bot_idx on eval_suites (workspace_id, bot_id, id);

create table eval_cases (
  id text primary key check (id ~ '^ec_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  suite_id text not null,
  script jsonb not null check (jsonb_typeof(script) = 'object'),
  revision integer not null default 1 check (revision > 0),
  foreign key (suite_id, bot_id, workspace_id) references eval_suites (id, bot_id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('eval_cases');
create index eval_cases_suite_idx on eval_cases (workspace_id, suite_id, id);

create table eval_runs (
  id text primary key check (id ~ '^er_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  suite_id text not null,
  connection_id text not null unique,
  target jsonb not null check (jsonb_typeof(target) = 'object'),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  cases jsonb not null check (jsonb_typeof(cases) = 'array'),
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'error')),
  created_at timestamptz not null default now(),
  foreign key (suite_id, bot_id, workspace_id) references eval_suites (id, bot_id, workspace_id) on delete cascade,
  foreign key (connection_id, bot_id, workspace_id) references bridge_connections (id, bot_id, workspace_id) on delete cascade,
  unique (id, workspace_id)
);
call app_internal.enable_tenant_rls('eval_runs');
create index eval_runs_suite_idx on eval_runs (workspace_id, suite_id, id desc);
create index eval_runs_active_idx on eval_runs (workspace_id, id) where status in ('queued','running');

create table eval_results (
  workspace_id text not null,
  run_id text not null,
  case_id text not null check (case_id ~ '^ec_[0-9a-hjkmnp-tv-z]{26}$'),
  detail jsonb not null check (jsonb_typeof(detail) = 'object'),
  primary key (workspace_id, run_id, case_id),
  foreign key (run_id, workspace_id) references eval_runs (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('eval_results');

create table eval_turn_results (
  workspace_id text not null,
  run_id text not null,
  case_id text not null check (case_id ~ '^ec_[0-9a-hjkmnp-tv-z]{26}$'),
  turn_index integer not null check (turn_index >= 0),
  detail jsonb not null check (jsonb_typeof(detail) = 'object'),
  primary key (workspace_id, run_id, case_id, turn_index),
  foreign key (run_id, workspace_id) references eval_runs (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('eval_turn_results');
