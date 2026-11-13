# ADR-008 — Queues: BullMQ for dispatch, Postgres for truth

Status: accepted · Date: 2026-11-13

## Context
A turn must run exactly one at a time per conversation, in arrival order, and survive worker crashes. Webhooks must be delivered in order per conversation. KB ingestion is multi-stage. The default stack names Redis + BullMQ. Durable-execution engines (Temporal, Restate, DBOS) are the usual recommendation for multi-step work with side effects.

## Decision
- **Postgres holds the truth; BullMQ only wakes workers.**
  - Inbound events are rows in `inbound_events` with a per-conversation sequence. A `turn` job carries only the conversation id and is deduplicated by `jobId`.
  - A worker takes a **lease** on the conversation row (owner, expiry, monotonically increasing epoch) and drains the inbox in order. Every state write is fenced by the epoch.
  - Outbound events are rows in an outbox written in the same transaction as the state change. A `webhook` job per conversation stream sends the next undelivered event.
  - If Redis loses jobs, a janitor re-enqueues conversations with unprocessed events and streams with pending deliveries. Nothing is lost.
- **Each engine step is a transaction** (state + messages + outbox). A crashed turn resumes at the step that did not commit.
- **KB ingestion** is one job per stage per document with stage status in `kb_ingestion_jobs`; stages are idempotent by content hash.
- BullMQ open-source features only (no Pro groups).

## Alternatives considered
- **Temporal**: correct tool for long, branching, money-moving workflows; here turns are seconds long and the "workflow" state is the conversation row we already persist. Adds a cluster to operate. Rejected for now.
- **Postgres-only queue (pg-boss, graphile-worker)**: removes Redis from the turn path. Viable; not chosen because Redis is already needed for pub/sub (sync mode, SSE), rate limiting and quota counters.
- **BullMQ as the source of truth with per-conversation concurrency**: needs Pro groups or fragile locks; loses ordering guarantees on Redis failover.

## Consequences
- At-least-once execution of a step after a crash; cards with side effects get an idempotency key.
- Lease expiry (30 s, heartbeat 10 s) bounds how long a crashed worker blocks a conversation.
- Redis is not a durability dependency; it can be a single node at the start.

## Revisit when
We add long-running tools with compensation logic, or scheduled multi-day flows; then evaluate DBOS (Postgres-backed) first.
