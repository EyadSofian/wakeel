-- 0014 config variable values (task 7.3, architecture §2.3, ADR-037). Runs as app_migrator.
--
-- The manifest declares config variable names (`configVars`); their values live here, one per bot,
-- environment and key. Every value is sealed with the envelope helper (task 1.5) whether or not it
-- is secret, bound to `bot_config_vars:<workspace>:<bot>:<env>:<key>` so a copied row never opens.
-- `is_secret` decides whether the value may ever be shown again (non-secret settings) or only used.

create table bot_config_vars (
  workspace_id text not null,
  bot_id text not null,
  env text not null check (env in ('draft', 'production')),
  key text not null check (key ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ciphertext bytea not null,
  key_version integer not null check (key_version > 0),
  is_secret boolean not null default true,
  updated_by text references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bot_id, env, key),
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade
);
call app_internal.enable_tenant_rls('bot_config_vars');
