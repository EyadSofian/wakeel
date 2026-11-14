-- 0005 runtime (task 4.1, architecture §2.3 "Runtime", §4.2–4.4, §9). Runs as app_migrator.
--
-- The tables a conversation lives in: the bridge connection it arrives through, the end user, the
-- conversation and its leased state, the inbox of inbound events, turns, the transcript, and the
-- outbox of bridge events. webhook_deliveries arrives with outbound delivery (Phase 5).
--
-- Every link between these tables is a composite foreign key that includes workspace_id. Foreign
-- key checks do not apply RLS, so a plain id key would let one tenant point a row at another
-- tenant's row whose id it learned. Where two parents must agree (a conversation's end user must
-- belong to the same connection), the key carries both columns.
--
-- Ids follow ADR-012; versions are checked by format until bot_versions exists (7.1).
-- updated_at is set by the application, not by triggers.

-- Bridge connections ---------------------------------------------------------------------------

create table bridge_connections (
  id text primary key check (id ~ '^conn_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  name text not null check (length(name) between 1 and 100),
  -- production runs the published version; draft runs the draft (§3.2).
  target text not null check (target in ('production', 'draft')),
  webhook_url text check (length(webhook_url) <= 2048 and webhook_url ~ '^https?://'),
  -- Ciphertexts of the signing secrets, newest first; two during a rotation (§9.2).
  signing_secrets jsonb not null default '[]' check (jsonb_typeof(signing_secrets) = 'array'),
  subscribed_events text[] not null default '{}' check (
    subscribed_events <@ array['message.created', 'typing', 'handoff.requested', 'conversation.ended',
      'turn.completed', 'error']::text[]
  ),
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  consecutive_dead integer not null default 0 check (consecutive_dead >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade,
  unique (id, workspace_id),
  unique (id, bot_id, workspace_id)
);
call app_internal.enable_tenant_rls('bridge_connections');
create index bridge_connections_bot_idx on bridge_connections (workspace_id, bot_id, created_at desc, id desc);

-- The foreign keys promised in 0003: a key names a bot and a connection of its own workspace.
-- A bridge key is useless without its connection, so it goes with it.
alter table api_keys
  add foreign key (bot_id, workspace_id) references bots (id, workspace_id) on delete cascade,
  add foreign key (connection_id, workspace_id) references bridge_connections (id, workspace_id) on delete cascade;

-- End users ------------------------------------------------------------------------------------

create table end_users (
  id text primary key check (id ~ '^eu_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  connection_id text not null,
  -- The bridge's own id for the user (§9.1).
  external_id text not null check (length(external_id) between 1 and 255),
  -- Data pushed by the bridge; read-only to the bot as user.attributes (§4.5).
  attributes jsonb not null default '{}' check (jsonb_typeof(attributes) = 'object'),
  -- The bot's user-scope variables, across conversations.
  vars jsonb not null default '{}' check (jsonb_typeof(vars) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (connection_id, bot_id, workspace_id)
    references bridge_connections (id, bot_id, workspace_id) on delete cascade,
  unique (connection_id, external_id),
  unique (id, connection_id, workspace_id)
);
call app_internal.enable_tenant_rls('end_users');

-- Conversations --------------------------------------------------------------------------------

create table conversations (
  id text primary key check (id ~ '^conv_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  bot_id text not null,
  connection_id text not null,
  end_user_id text not null,
  external_id text not null check (length(external_id) between 1 and 255),
  mode text not null check (mode in ('live', 'emulator', 'eval')),
  status text not null default 'idle'
    check (status in ('idle', 'waiting_input', 'waiting_external', 'handed_off', 'ended')),
  -- Null while the conversation runs the draft (emulator, target=draft); see §3.2.
  version_id text check (version_id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
  -- ConversationState (04-contracts/runtime.ts), parsed with its schema on read and write.
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  -- Serialised size as the engine measured it; the 256 KB limit is enforced there (§4.4).
  state_bytes integer not null check (state_bytes >= 0),
  next_in_seq bigint not null default 1 check (next_in_seq >= 1),
  next_out_seq bigint not null default 1 check (next_out_seq >= 1),
  -- The turn worker's lease (§4.3). Every state write includes "and lease_epoch = $epoch".
  lease_owner text check (length(lease_owner) <= 200),
  lease_until timestamptz,
  lease_epoch bigint not null default 0 check (lease_epoch >= 0),
  last_activity_at timestamptz not null default now(),
  -- last_activity_at + the inactivity timeout; null when the timeout is 0 (never).
  expires_at timestamptz,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('completed', 'inactivity', 'manual', 'error')),
  handoff jsonb check (jsonb_typeof(handoff) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((ended_at is null) = (ended_reason is null)),
  foreign key (connection_id, bot_id, workspace_id)
    references bridge_connections (id, bot_id, workspace_id) on delete cascade,
  foreign key (end_user_id, connection_id, workspace_id)
    references end_users (id, connection_id, workspace_id) on delete cascade,
  unique (connection_id, external_id),
  unique (id, workspace_id),
  unique (id, connection_id, workspace_id),
  unique (id, bot_id, workspace_id)
);
call app_internal.enable_tenant_rls('conversations');
-- The janitor's inactivity scan.
create index conversations_expires_idx on conversations (expires_at) where ended_at is null;
create index conversations_bot_activity_idx on conversations (workspace_id, bot_id, last_activity_at desc, id desc);

-- Inbound events (the inbox) -------------------------------------------------------------------

create table inbound_events (
  id text primary key check (id ~ '^evt_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  connection_id text not null,
  conversation_id text not null,
  -- conversations.next_in_seq at insert; the worker drains in this order.
  seq bigint not null check (seq >= 1),
  kind text not null
    check (kind in ('message', 'event', 'user_update', 'tool_result', 'handoff_release', 'timeout')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- The caller's Idempotency-Key (§9.1).
  idempotency_key text check (length(idempotency_key) between 1 and 255),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  -- Foreign key added below, once turns exists.
  turn_id text,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, connection_id, workspace_id)
    references conversations (id, connection_id, workspace_id) on delete cascade,
  unique (conversation_id, seq),
  -- Nulls are distinct: events sent without a key are not limited.
  unique (connection_id, idempotency_key),
  unique (id, conversation_id, workspace_id)
);
call app_internal.enable_tenant_rls('inbound_events');
-- The worker's and janitor's "oldest unprocessed event" reads.
create index inbound_events_unprocessed_idx on inbound_events (conversation_id) where processed_at is null;

-- Turns ----------------------------------------------------------------------------------------

create table turns (
  id text primary key check (id ~ '^turn_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  conversation_id text not null,
  bot_id text not null,
  version_id text check (version_id ~ '^ver_[0-9a-hjkmnp-tv-z]{26}$'),
  trigger_event_id text not null,
  -- running while the worker owns it, then the turn.completed status (04-contracts/event.ts).
  status text not null default 'running'
    check (status in ('running', 'completed', 'waiting', 'handed_off', 'ended', 'failed')),
  step_count integer not null default 0 check (step_count >= 0),
  usage jsonb not null default '{}' check (jsonb_typeof(usage) = 'object'),
  error jsonb check (jsonb_typeof(error) = 'object'),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'running') = (ended_at is null)),
  foreign key (conversation_id, bot_id, workspace_id)
    references conversations (id, bot_id, workspace_id) on delete cascade,
  -- No cascade: an event and its turn go together, with their conversation.
  foreign key (trigger_event_id, conversation_id, workspace_id)
    references inbound_events (id, conversation_id, workspace_id),
  unique (id, conversation_id, workspace_id)
);
call app_internal.enable_tenant_rls('turns');
create index turns_conversation_idx on turns (conversation_id, started_at desc, id desc);

alter table inbound_events
  add foreign key (turn_id, conversation_id, workspace_id) references turns (id, conversation_id, workspace_id);

-- Messages (the transcript) --------------------------------------------------------------------

create table messages (
  -- Bot messages have deterministic ids (msg_ + hash of turnId, stepSeq, index; §4.4), so the
  -- primary key is what stops a retried step from writing its output twice.
  id text primary key check (id ~ '^msg_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  conversation_id text not null,
  -- Position in the transcript; strictly increasing (04-contracts/message.ts).
  seq bigint not null check (seq >= 0),
  direction text not null check (direction in ('in', 'out')),
  type text not null check (
    type in ('text', 'image', 'file', 'location', 'choice', 'dropdown', 'card', 'carousel', 'custom', 'postback')
  ),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  citations jsonb not null default '[]' check (jsonb_typeof(citations) = 'array'),
  turn_id text,
  -- The bridge's own id for an inbound message, if it sent one.
  external_id text check (length(external_id) between 1 and 255),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, workspace_id) references conversations (id, workspace_id) on delete cascade,
  foreign key (turn_id, conversation_id, workspace_id) references turns (id, conversation_id, workspace_id),
  unique (conversation_id, seq)
);
call app_internal.enable_tenant_rls('messages');

-- Outbox (bridge events) -----------------------------------------------------------------------

create table outbox_events (
  id text primary key check (id ~ '^out_[0-9a-hjkmnp-tv-z]{26}$'),
  workspace_id text not null,
  connection_id text not null,
  conversation_id text not null,
  -- conversations.next_out_seq at insert, from 1. Ephemeral events have none (04-contracts/event.ts).
  seq bigint check (seq >= 1),
  type text not null check (
    type in ('message.created', 'typing', 'handoff.requested', 'conversation.ended', 'turn.completed', 'error')
  ),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  ephemeral boolean not null default false,
  created_at timestamptz not null default now(),
  check ((seq is null) = ephemeral),
  foreign key (conversation_id, connection_id, workspace_id)
    references conversations (id, connection_id, workspace_id) on delete cascade,
  unique (conversation_id, seq)
);
call app_internal.enable_tenant_rls('outbox_events');
