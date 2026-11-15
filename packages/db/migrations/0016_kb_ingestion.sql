-- 0016 ingestion stage records (task 8.4, architecture §8.1, ADR-041). Runs as app_migrator.
--
-- One row per document and stage: the pipeline upserts it, so a retried or repeated job updates the
-- same record instead of piling up rows. content_hash says which version of the document the stage
-- last finished for; a stage whose hash matches is skipped (idempotent by content_hash).

drop index kb_ingestion_jobs_doc_idx;
alter table kb_ingestion_jobs
  add column content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  add column started_at timestamptz,
  add column finished_at timestamptz,
  add constraint kb_ingestion_jobs_document_stage_key unique (document_id, stage);
