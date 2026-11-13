-- 0003 platform (task 1.1, architecture §2.3, ADR-004, ADR-015). Runs as app_migrator.
--
-- 1. Auth tables in better-auth's shape (ADR-015). Platform tables: no workspace_id, no RLS.
-- 2. Workspaces (platform) and the tenant tables: memberships, invitations, api_keys,
--    workspace_secrets, audit_log. Each tenant table gets forced RLS in the statement after it.
-- 3. Pre-tenant lookups in schema `lookup`, owned by app_lookup, returning ids only.
--
-- Ids are checked against their ADR-012 format so a row can never carry another entity's id.
-- updated_at is set by the application (and by better-auth for its tables), not by triggers.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_lookup') then
    raise exception 'Role app_lookup does not exist. Run pnpm db:bootstrap (ADR-015), then migrate again.';
  end if;
end;
$$;

-- citext is a trusted extension: app_migrator may create it with CREATE on the database.
create extension if not exists citext;

-- Auth (better-auth model, ADR-015) ------------------------------------------------------------

create table users (
  id text primary key check (id ~ '^usr_[0-9a-hjkmnp-tv-z]{26}$'),
  email citext not null unique check (length(email) between 3 and 320),
  name text not null check (length(name) between 1 and 200),
  email_verified boolean not null default false,
  image text check (length(image) <= 2048),
  locale text not null default 'en' check (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sessions (
  id text primary key check (id ~ '^ses_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text not null references users (id) on delete cascade,
  -- Stored as better-auth issues it; the cookie carries it signed with AUTH_SECRET (ADR-015).
  token text not null unique,
  expires_at timestamptz not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sessions_user_id_idx on sessions (user_id);

create table accounts (
  id text primary key check (id ~ '^acc_[0-9a-hjkmnp-tv-z]{26}$'),
  user_id text not null references users (id) on delete cascade,
  provider_id text not null,
  account_id text not null,
  -- Password hash for provider_id = 'credential'.
  password text,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, account_id)
);
create index accounts_user_id_idx on accounts (user_id);

create table verifications (
  id text primary key check (id ~ '^vrf_[0-9a-hjkmnp-tv-z]{26}$'),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index verifications_identifier_idx on verifications (identifier);

-- Support tooling has no business reading credentials (threat T12).
revoke all on sessions, accounts, verifications from app_admin_ro;

-- Workspaces -----------------------------------------------------------------------------------

create table workspaces (
  id text primary key check (id ~ '^ws_[0-9a-hjkmnp-tv-z]{26}$'),
  name text not null check (length(name) between 1 and 100),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
  plan text not null default 'free' check (plan ~ '^[a-z][a-z0-9_]{0,31}$'),
  region text not null default 'default' check (region ~ '^[a-z][a-z0-9-]{0,31}$'),
  settings jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memberships (
  id text primary key check (id ~ '^mem_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'builder', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
call app_internal.enable_tenant_rls('memberships');
create index memberships_user_id_idx on memberships (user_id);

create table invitations (
  id text primary key check (id ~ '^inv_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  email citext not null check (length(email) between 3 and 320),
  role text not null check (role in ('owner', 'admin', 'builder', 'viewer')),
  -- SHA-256 of the token in the invitation link; the token itself is never stored.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by text references users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by text references users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- accepted_by may later become null (user deleted), so only one direction is enforced.
  check (accepted_by is null or accepted_at is not null),
  check (accepted_at is null or revoked_at is null)
);
call app_internal.enable_tenant_rls('invitations');
-- One open invitation per address and workspace; revoke or accept it before inviting again.
create unique index invitations_open_email_idx on invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

create table api_keys (
  id text primary key check (id ~ '^key_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  kind text not null check (kind in ('workspace', 'bridge')),
  name text not null check (length(name) between 1 and 100),
  -- The 8-character prefix in the key locates the row (ADR-012); unique across all workspaces.
  prefix text not null unique check (prefix ~ '^[0-9a-z]{8}$'),
  -- SHA-256 of the secret part; the key itself is shown once and never stored.
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{}',
  -- Foreign keys arrive with the bots (2.1) and bridge_connections (4.1) tables.
  bot_id text check (bot_id ~ '^bot_[0-9a-hjkmnp-tv-z]{26}$'),
  connection_id text check (connection_id ~ '^conn_[0-9a-hjkmnp-tv-z]{26}$'),
  created_by text references users (id) on delete set null,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A bridge key belongs to exactly one connection; a workspace key to none.
  check ((kind = 'bridge') = (connection_id is not null))
);
call app_internal.enable_tenant_rls('api_keys');
create index api_keys_workspace_created_idx on api_keys (workspace_id, created_at desc, id desc);

create table workspace_secrets (
  id text primary key check (id ~ '^sec_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  -- Envelope from packages/db/src/crypto.ts (task 1.5): wrapped data key, nonce, tag, ciphertext.
  ciphertext bytea not null,
  key_version integer not null check (key_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
call app_internal.enable_tenant_rls('workspace_secrets');

create table audit_log (
  id text primary key check (id ~ '^aud_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null references workspaces (id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'api_key', 'system')),
  actor_id text,
  action text not null check (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  target_type text check (target_type ~ '^[a-z][a-z_]*$'),
  target_id text,
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  ip inet,
  at timestamptz not null default now(),
  check ((actor_type = 'system') = (actor_id is null))
);
call app_internal.enable_tenant_rls('audit_log');
create index audit_log_workspace_at_idx on audit_log (workspace_id, at desc, id desc);
-- Append-only: the application may add entries and read them, never change or remove them.
revoke update, delete, truncate on audit_log from app_rw;

-- Pre-tenant lookups (ADR-004, ADR-015) --------------------------------------------------------
--
-- Each function runs as app_lookup (nologin, bypassrls), reads only the columns granted below and
-- returns only ids. Callers then open withWorkspace for the returned workspace and read the row
-- there, under RLS.

create schema lookup;
revoke all on schema lookup from public;
grant usage on schema lookup to app_rw;
-- A function's new owner needs CREATE on its schema.
grant usage, create on schema lookup to app_lookup;

grant select (workspace_id, user_id) on memberships to app_lookup;
grant select (id, workspace_id, prefix) on api_keys to app_lookup;
grant select (id, workspace_id, token_hash) on invitations to app_lookup;

-- Session → the workspaces its user belongs to (workspace switcher, sign-in redirect).
create function lookup.user_workspace_ids(p_user_id text)
returns setof text
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select m.workspace_id from public.memberships m where m.user_id = p_user_id order by m.workspace_id
$$;

-- API key prefix → the key row and its workspace. Revocation and the secret are checked by the
-- caller inside withWorkspace.
create function lookup.api_key_by_prefix(p_prefix text)
returns table (key_id text, workspace_id text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select k.id, k.workspace_id from public.api_keys k where k.prefix = p_prefix
$$;

-- Invitation token hash → the invitation and its workspace, for a user who is not a member yet.
create function lookup.invitation_by_token_hash(p_token_hash text)
returns table (invitation_id text, workspace_id text)
language sql stable security definer
set search_path = pg_catalog, public
as $$
  select i.id, i.workspace_id from public.invitations i where i.token_hash = p_token_hash
$$;

revoke all on function lookup.user_workspace_ids(text) from public;
revoke all on function lookup.api_key_by_prefix(text) from public;
revoke all on function lookup.invitation_by_token_hash(text) from public;

grant execute on function lookup.user_workspace_ids(text) to app_rw;
grant execute on function lookup.api_key_by_prefix(text) to app_rw;
grant execute on function lookup.invitation_by_token_hash(text) to app_rw;

-- Last, because after this app_migrator no longer owns the functions and cannot change their grants.
-- The grants above carry over to the new owner.
alter function lookup.user_workspace_ids(text) owner to app_lookup;
alter function lookup.api_key_by_prefix(text) owner to app_lookup;
alter function lookup.invitation_by_token_hash(text) owner to app_lookup;
