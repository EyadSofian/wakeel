# ADR-028 — Webhook delivery: rows, streams, leases and what is not delivered

Status: proposed (implemented as proposed in task 5.2; review with that PR) · Date: 2026-11-14

## Context

Task 5.2 builds the delivery worker. Architecture §9.2, §11 and ADR-005 fix the rules: one ordered stream per conversation, head-of-line blocking, the retry schedule with ±20% jitter, dead-lettering that leaves a `seq` gap, 20 consecutive dead events disable the connection, ephemeral events are best-effort, and delivery goes through egress. §2 gives the table: `webhook_deliveries (id, outbox_event_id, attempt, status, next_attempt_at, response_status?, error?, duration_ms?)`, with status `pending | delivered | failed | dead` and an index on `next_attempt_at where status = 'pending'`.

The docs leave these open:

1. **When a delivery exists.** The outbox holds every event, including ones for connections with no webhook URL, unsubscribed types and the emulator.
2. **One row per event or per attempt.** The columns (`attempt`, `status` with `failed` and `dead`) read like one row per attempt, but this is not stated.
3. **How a stream is kept to one sender at a time** while an HTTP call (up to 10 s) is in flight.
4. **How retries wake up** on a queue whose job id is the conversation.
5. **Ephemeral events.** "Best-effort, unordered, never retried" does not say whether they get a row.
6. **Eval and emulator traffic.** CLAUDE.md §9 says eval traffic is never billed or counted as live. Nothing says whether it reaches the bridge's receiver.
7. **Redirects, egress refusals and paused connections.**
8. **"Notify workspace admins"** when a connection is disabled. The platform has no notification channel.
9. **A delivery id prefix** (ADR-012 lists none).

## Decision

1. **A delivery is created with its outbox row, in the same transaction.** `appendOutbox` inserts a `pending` attempt-1 row for each event whose connection has a webhook URL and lists the event type in `subscribed_events` (an empty list subscribes to nothing). The conversation must not be in `eval` mode. Setting a webhook URL later does not backfill old events. Unsubscribing later does not cancel pending deliveries.
2. **One row per attempt.** An attempt updates its row to `delivered`, `failed` or `dead`, with `response_status`, `error`, `duration_ms` and `attempted_at`. If it failed and the schedule has a step left, the same transaction inserts attempt `n+1` as `pending` with `next_attempt_at = attempted_at + delay ± 20%`. The 9th failure (the 8 retries are used up) is stored as `dead`. Replay (task 5.3) adds a new `pending` row. `unique (outbox_event_id, attempt)`.
3. **The head is leased, not the conversation.**
   - The stream's head is the lowest-`seq` pending ordered row of the conversation.
   - A sender claims it with `update … set lease_until = now + 30 s where id = $1 and status = 'pending' and (lease_until is null or lease_until < now)`. One row per stream can be the head, so this keeps one sender per stream without holding a transaction open during the HTTP call.
   - Different conversations never wait for each other.
4. **Jobs only wake senders (ADR-008).**
   - The turn worker enqueues `webhook` with job id = conversation id after a commit that created deliveries.
   - When the head is not due yet, the job adds a delayed job with job id `<conversationId>-<deliveryId>`, so it is not swallowed by the job that is running.
   - The janitor also enqueues every conversation with a due, unleased pending row (`lookup.webhook_streams_due`). This covers lost Redis jobs and expired leases.
   - All times come from the worker's clock port, so tests use the fake clock.
5. **Ephemeral events get one row and one attempt.** They are sent before the ordered head and don't wait for it. A failure is stored as `failed` and never retried. An ephemeral row older than 30 s when picked up is marked `dead` without being sent: a stale `typing` is worse than none.
6. **No delivery for `eval` conversations.** The eval runner reads results through the API (Phase 12). Emulator connections have no webhook URL (ADR-025), so they never get rows. `live` conversations on any connection with a URL do.
7. **Sending.**
   - `POST` through egress (`/v1/fetch`, `Bearer EGRESS_TOKEN`, the conversation's `workspaceId`), with `redirect: "manual"` and a 10 s timeout.
   - Headers: `X-Wakeel-Signature` (one `v1` per active secret, via `packages/bridge` signing), `X-Wakeel-Event-Id`, `X-Wakeel-Delivery-Attempt`, `Content-Type: application/json`, `User-Agent: Wakeel-Webhooks/1`.
   - Only a 2xx is success. A 3xx is a failure (a signed body is never forwarded to a host the builder did not configure). Egress refusals (`fetch_blocked`, `fetch_failed`, `rate_limited`) are failed attempts, with the code in `error`.
   - The body is the `BridgeEvent` built by `toBridgeEvent`, as for SSE and `wait`.
   - Signing secrets are opened from `bridge_connections.signing_secrets`, with AAD `bridge_connections:<workspaceId>:<connectionId>`. A connection with a URL and no secret is not sent to: the attempt fails with `webhook_secret_missing`.
8. **Connection status.**
   - `paused` and `disabled` connections hold their streams: nothing is attempted, rows stay `pending`, and the stream resumes when the connection is active again (task 5.5).
   - A `delivered` attempt resets `consecutive_dead` to 0. A `dead` one adds 1.
   - Reaching 20 sets `disabled` and writes an audit entry `connection.disabled` (system actor, `{ consecutiveDead }`), which is how admins see it until a notification channel exists. The worker also logs an error.
9. **Ids.** Deliveries use the prefix `dlv` (added to `ids.ts`).
10. **Every failed attempt has a code from `errors.ts`** (CLAUDE.md §9), stored in `error` as `{ code, detail? }`: `webhook_rejected` (a non-2xx answer; the status is in `response_status`), `webhook_redirected`, `webhook_secret_missing`, `webhook_stale` (a dropped ephemeral event), and egress's own `fetch_blocked`, `fetch_failed` and `rate_limited`.

## Consequences

- Migration `0009_webhook_deliveries.sql`: the table under the standard RLS policy, the pending index from §2, `lookup.webhook_streams_due`, and `lease_until` and `attempted_at` columns beyond §2.
- `appendOutbox` returns how many deliveries it created, so the turn worker knows whether to enqueue.
- No `webhook.delivery` span yet. Deliveries happen outside a turn, and the trace is per turn until Phase 10. The Deliveries tab (5.5) reads the rows.
- Admins are not actively notified. That stays open until a notification channel exists (not in the plan).
