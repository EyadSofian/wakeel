-- 0010 remaining Bridge operations (task 5.3, ADR-029). Runs as app_migrator.
--
-- 1. `end`: endConversation goes through the inbox like every other state change (ADR-029 §1).
-- 2. `replay`: a replayed delivery is one out-of-band attempt, sent outside the ordered head so it
--    never blocks newer events (ADR-029 §3).

alter table inbound_events drop constraint inbound_events_kind_check;
alter table inbound_events add constraint inbound_events_kind_check
  check (kind in ('message', 'event', 'user_update', 'tool_result', 'handoff_release', 'timeout', 'run_from', 'end'));

alter table webhook_deliveries add column replay boolean not null default false;
-- The ordered head ignores replays; keep its index to the rows it reads.
drop index webhook_deliveries_stream_idx;
create index webhook_deliveries_stream_idx on webhook_deliveries (conversation_id, seq)
  where status = 'pending' and not replay;
