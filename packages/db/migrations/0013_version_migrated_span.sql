-- 0013 version.migrated spans (task 7.2, architecture §3.2, ADR-036). Runs as app_migrator.
--
-- A live conversation that moves to a newly published version records one `version.migrated` span
-- at the start of the turn, listing what it dropped. The span kind joins the allowed list.

alter table trace_spans drop constraint trace_spans_kind_check;
alter table trace_spans add constraint trace_spans_kind_check check (kind in ('turn', 'node', 'card',
  'autonomy.iteration', 'llm.call', 'code.exec', 'tool.call', 'kb.search', 'table.op', 'webhook.delivery',
  'version.migrated', 'error'));
