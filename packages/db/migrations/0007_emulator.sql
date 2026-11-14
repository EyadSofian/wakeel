-- 0007 emulator (task 4.6, ADR-025). Runs as app_migrator.
--
-- 1. A draft connection per builder session. The Studio emulator runs the Bridge inbound path for
--    a connection that belongs to one session; signing out (or the session's removal) deletes it,
--    and the existing cascades take its test users, conversations and transcripts with it. Such
--    connections always run the draft and are left out of the connections list (task 5.5).
--
-- 2. The internal `run_from` inbound kind for "Run from here". Only the Studio emulator route
--    inserts it, on emulator conversations; the Bridge API never does.

alter table bridge_connections
  add column emulator_session_id text references sessions (id) on delete cascade,
  add constraint bridge_connections_emulator_is_draft check (emulator_session_id is null or target = 'draft');

create unique index bridge_connections_emulator_idx
  on bridge_connections (emulator_session_id, bot_id) where emulator_session_id is not null;

alter table inbound_events drop constraint inbound_events_kind_check;
alter table inbound_events add constraint inbound_events_kind_check
  check (kind in ('message', 'event', 'user_update', 'tool_result', 'handoff_release', 'timeout', 'run_from'));
