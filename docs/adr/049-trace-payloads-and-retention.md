# ADR-049 — Trace payload access and partition retention

Status: accepted (Eyad approved in writing on 2026-11-15) · Date: 2026-11-15 · Task: 10.1

## Context

Architecture §12 and ADR-009 require small payloads inline, large redacted payloads in object
storage, a batched non-blocking trace writer, and monthly Postgres partitions. Span retention
defaults to 30 days and may vary by plan. Monthly partition drops alone cannot enforce different
workspace cutoffs or an exact 30-day cutoff. The current contract also permits multiple payloads
within a single span, while `trace_spans` has one `payload_key` column. ADR-026's empty-key
historical previews have no recoverable original bytes.

## Options

1. Store one redacted payload bundle per span and serve its named fields from the authorized
   trace API. Combine scoped deletion at the workspace cutoff, monthly partition housekeeping
   and an object lifecycle rule for orphan cleanup.
2. Store each field as a separate object and treat monthly detach as the sole retention rule.
   This requires independently tracking all keys and leaves different plan cutoffs unenforced.
3. Store all payloads in JSONB and trim rows with a global retention query. This misses the
   object-store requirement and grows the database and its backups.

## Recommendation

Option 1 approved.

- Prepare payloads before building stored spans so redaction precedes byte measurement,
  preview generation, uploads, persistence and SSE. Reuse the known secret redaction rules.
  Allow operator-configured PII patterns from trusted configuration only. Preserve the
  8 KiB inline threshold and 400-code-point preview. Use compact, UTF-8 encoded JSON.
- Store a single JSON bundle of the offloaded fields under a workspace/span prefix. The DB's
  `payload_key` is the canonical storage key. Each public payload reference carries an
  opaque named-field selector, with no storage credentials or direct object-store access.
  Preserve existing empty-key previews as unavailable. Use content-derived keys to make
  retried uploads idempotent without overwriting payloads still referenced by the database.
- Authorize a payload read with `conversation.read` and resolve the workspace, turn, span
  and selector from the stored trace before looking up the bundle. Return the requested JSON
  value through the API. Never accept a storage key from the request or return a signed URL.
- Upload bundles before upserting a batch of redacted spans. Keep the batched write outside
  the committed turn step. Bound object-store latency. On a payload upload failure, retain the
  redacted preview and span metadata with the payload marked unavailable. Record failures using
  error codes and counters so trace diagnostics contain no secret or payload values.
- Run recurring maintenance in the existing queue. Apply the workspace plan cutoff using
  bounded workspace-scoped row batches and fail-closed RLS. Use 30 days for plans without an
  operator override. Persist pending object deletions in the same transaction that removes
  span rows, then retry deletion through maintenance. Use a bucket lifecycle rule as a backstop
  for orphaned writes. Keep that age greater than the longest configured retention window.
- Create current and next UTC month partitions ahead of writes with the same forced RLS and
  privileges as migration 0008. Use narrowly scoped database maintenance procedures for DDL.
  Move any matching default-partition rows while attaching a missing month. Drop only
  fully expired, empty partitions. Keep the default partition as a catch-all.

## Consequences

The stored payload endpoint becomes the only route from a trace reference to its bytes. Several
payload fields share a bundle and therefore one deletion operation. Per-workspace expiry can take
effect before a partition is empty. Integration tests cover Arabic large-payload round trips,
canary redaction before both writes, workspace isolation, retryable object deletion and the next
UTC month partition. Conversation retention remains separate from span retention.
