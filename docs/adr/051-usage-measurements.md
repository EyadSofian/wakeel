# ADR-051 — Usage event identity and storage measurements

Status: accepted (Eyad approved in writing on 2026-11-15) · Date: 2026-11-15 · Task: 11.1

## Context

Architecture §13 names the eight usage kinds and excludes emulator and eval events from
billing. It does not define retry identities, the billing timezone, or how a current storage
quantity differs from consumed tokens. Summing repeated storage samples would charge the
same rows repeatedly. The new usage contract must make that distinction explicit.

## Options

1. Keep consumption events additive, and tag hourly occupancy samples separately. Select the
   latest sample per bot and kind when displaying current storage. Use UTC calendar periods
   and transactionally deduplicate events that describe the same completed mutation.
2. Sum every quantity, including repeated storage samples, and let the billing provider correct
   them. This would produce misleading meters before a provider exists.
3. Introduce byte-hour and row-hour kinds. Those are different products and would change the
   architecture's usage kinds.

## Recommendation

Use option 1:

- Add a shared usage-event input contract with the existing kinds, units and traffic modes.
  Optional source keys are internal accounting identities, not user-provided content. Validate
  JSON detail on write and read. Enforce the unit belonging to each kind.
- Count a conversation on its second inbound user message within each UTC calendar month,
  once per workspace/conversation/month, using the conversation's persisted mode. Serialize
  concurrent inbound writes on the conversation and insert the identity in the same transaction.
- Meter every sandbox Code execution in milliseconds and each actual webhook HTTP attempt
  once. Blocked replay Code execution produces no Code usage. Keep the existing model-layer
  token, embedding and rerank events and their mode tags.
- Store hourly `table_rows` and `kb_storage_bytes` samples with `detail.measurement = snapshot`.
  The former is current rows; the latter is the logical PostgreSQL payload size of all retained
  KB chunk records, including embeddings and metadata. This meter excludes object-store files,
  PostgreSQL index overhead and replication. Label it **Knowledge index storage** in Studio;
  do not represent it as the hosting provider's physical disk bill.
- Current storage totals select the latest sample per bot/kind in the requested period, then
  sum across bots. Additive totals sum all other kinds. Daily roll-ups retain the last storage
  sample per bot/kind/day. Never sum hourly occupancy samples into consumption.
- Archive and deletion must be reflected in the next sample. Sampling also emits a zero when
  a bot has no remaining rows or chunks. A removed bot's last sample must not inflate current
  occupancy; current totals only include existing, non-archived bots.

## Consequences

Source identities require a new forced-RLS tenant table and two-tenant tests. Storage samples
are not invoices and do not define a storage price. Billing remains manual with a no-op adapter.
Plan prices, allowances and quota reservations require a separate decision before task 11.2.
