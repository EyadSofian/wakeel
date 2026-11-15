# ADR-041 — Ingestion stages: where stage output lives, what "normalise" does, which model reads pages

Status: accepted (Eyad approved in writing on 2026-11-15) · Date: 2026-11-15

## Context

Architecture §8.1 fixes the stages (`fetch → parse → normalise → chunk → embed → index`), one BullMQ job per stage per document, progress in `kb_ingestion_jobs`, and each stage idempotent by `content_hash`. Task 8.4's acceptance: re-ingesting an unchanged document does no work, and a failed embed resumes from that stage. The docs do not say:

1. where one stage's output waits for the next;
2. what the "normalise" stage does, given that search normalisation must run per chunk at index **and** query time and that "original text is kept for display and embedding";
3. how a stage record is identified;
4. which model the OCR tier (ADR-040) uses.

## Decision

1. **Stage output goes to the object store** under `ws/<workspace>/kb/<kb>/<document>/<content_hash>.<name>`: `raw` (non-file sources), `parsed.json`, `md`, `chunks.json`, `v<index_version>.vectors.json`. Postgres keeps only the records and the final chunks. A retried stage reads its input from there, so a failed embed never re-parses. Content-addressed names make re-runs overwrite identical objects.
2. **Normalise** is display-safe cleanup of the whole document: NFC, and removal of control and invisible formatting characters except ZWJ and ZWNJ, plus collapsing blank lines. The Arabic search normaliser (`arabic.ts`) runs per chunk in the index stage and on queries, so both sides use one function, as §8.1 requires.
3. **One stage record per (document, stage)** (migration 0016: unique constraint, `content_hash`, `started_at`, `finished_at`). A stage is skipped when its record is `done` for the document's current hash. The fetch stage ends the pipeline early when the new hash equals the stored one, the document is ready, and chunks exist for the current index version.
4. **The OCR tier uses `knowledge_bases.settings.ocrModel`**, a vision model from the registry chosen per knowledge base (Studio, 8.8). With none set there is no OCR: scanned pages stay empty and Arabic pages keep Docling's text with the `rtl_order` warning. `settings.maxOcrPages` overrides the default cap of 50.
5. Embedding vectors from models with more than 1024 dimensions are truncated and re-normalised; fewer is an error (ADR-007 §1). Embedding calls are recorded as `embedding_tokens` with purpose `kb_embed`.

## Consequences

- The object store holds intermediate files per content version. The maintenance job that cleans pending uploads (ADR-039) also deletes artifacts of hashes no longer current, in 8.5's re-sync work.
- Token counts are estimates (2.5 characters per token for Arabic, 4 for other text), which err high. That keeps chunks under model limits without a tokenizer per model.
