# ADR-009 — Traces: partitioned Postgres rows plus object storage for payloads

Status: accepted · Date: 2026-11-13

## Context
Per-turn traces (prompts, generated code, tool calls, tokens, latency) are a core product surface: the emulator, the trace viewer, evals and replay all read them. Volume is high and payloads are large.

## Decision
- Span metadata in `trace_spans`, range-partitioned by month, under RLS like everything else.
- Payloads over 8 KB go to the object store, keyed by workspace and span id; smaller ones stay inline in `attrs`.
- Redaction (tenant secrets, configured PII patterns) runs before anything is written.
- The writer batches inserts per step and never blocks the turn on failure: on error it logs, increments a metric and continues.
- Retention is partition drop plus object-store lifecycle rules.
- Span naming follows OpenTelemetry GenAI conventions where they exist, so optional OTLP export of metadata is a mapping, not a redesign.

## Alternatives considered
- **Langfuse (self-hosted)**: mature tracing UI and evals. Rejected as the primary store: it brings ClickHouse and its own tenancy model, and the trace viewer is a product screen we must design ourselves. Export to Langfuse over OTLP remains possible.
- **ClickHouse from day one**: right at scale, premature now.
- **Everything in JSONB**: bloats the main database and backups.

## Consequences
- Trace queries are simple (by turn, by conversation); cross-conversation analytics on spans will be slow and are served from `usage_daily` roll-ups instead.
- The object store becomes required infrastructure.

## Revisit when
`trace_spans` exceeds ~50 M rows per month or analytics need span-level aggregation.
