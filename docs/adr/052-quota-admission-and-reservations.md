# ADR-052 — Plan quotas and conservative admission reservations

Status: proposed · Date: 2026-11-15 · Task: 11.2

## Context

Architecture §13 requires Redis quota counters reconciled from usage events, hard caps, a
quota message without model calls, and workspace concurrency buckets. Open questions 5 and 6
leave commercial allowances and prices with Eyad. Checking a cached total alone permits
parallel calls to overshoot a cap; a Redis flush must not restore a depleted allowance.

## Options

1. Operator-defined plan limits, durable reservations under a workspace lock, and rebuildable
   Redis counters. Reserve a conservative upper bound before starting resource consumption.
2. Check actual totals at turn start only. Simpler, but concurrent calls can exceed a hard cap.
3. Set commercial tiers and charge automatic overage. This guesses unresolved product decisions.

## Recommendation

Use option 1, without setting prices or taking payment:

- Operators configure named plans through validated `QUOTA_PLANS` JSON. Each plan specifies
  monthly limits per usage kind, an optional micro-USD spend cap, and concurrent live turns.
  `null` explicitly means unlimited. No allowance or price is inferred. An unknown plan fails
  closed for live work with a diagnosable configuration error. Emulator and eval calls bypass
  live quotas and concurrency accounting while retaining their usage mode.
- Periods are UTC calendar months, consistent with ADR-051. Workspace owners may lower hard
  caps within the operator's allowance, but cannot grant themselves a higher entitlement.
  Overage remains disabled. Changes are audited, ETag-protected and restricted to settings writers.
- Check the current consumed totals before starting a live turn. At a reached hard cap, write
  the configured quota message and `quota_exceeded` event through the ordinary turn outbox;
  make no model call. Concurrency exhaustion defers the queued turn rather than consuming
  or dropping its input. Existing per-conversation leases still fence turn execution.
- Before each model attempt (including utility, embedding, rerank and fallback calls), reserve
  a conservative bound for the relevant units and spend. Chat/vision bounds use the registered
  context window and requested maximum output, capped by the registry. Embedding bounds use
  UTF-8 input bytes; rerank bounds use the known document count. Spend bounds use the highest
  applicable registry price, including cache-write and long-context rates. A request without a
  defensible finite bound is refused when that resource has a finite cap.
- Use a tenant-scoped durable reservation table and serialize admission/reconciliation with a
  workspace advisory transaction lock. Redis stores period counters and active buckets, but
  never grants capacity based solely on an empty cache. On a missing key, reconstruct measured
  consumption and outstanding reservations before admitting a call. Reconcile hourly too.
- On success, write measured usage before releasing its reservation. A crashed or uncertain
  provider attempt retains its bound until an operator resolves it or the period ends; do not
  silently reclaim capacity for potentially billed work. Reservation values are capacity holds,
  never invoices. Redis failure refuses new finite-cap work rather than bypassing the cap.
- Reserve bounded sandbox durations before execution. Existing table row limits remain in
  force; storage caps compare the latest occupancy and refuse new growth. Webhook accounting
  includes every HTTP attempt. Diagnostic quota events are exempt from a delivery allowance so
  the explanation itself can still reach the caller.

## Consequences

Conservative context-window reservations may reject a call whose actual result would fit;
Studio must explain reserved capacity separately from consumed usage. Durable reservation
and settings changes need isolation tests and human review. Redis reconciliation tests include
flush and concurrent admission. This decision does not approve commercial plan numbers,
platform model keys, automatic charges, or a production isolation exception.
