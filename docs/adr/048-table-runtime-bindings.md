# ADR-048 — Table runtime binding, replies and write safety

Status: proposed · Date: 2026-11-15 · Task: 9.3

## Context

Architecture §§4.3–4.4, 5.2, 6.5 and 10 enable table operations through cards, builder code
and listed Autonomous Node tools. The generated guest declarations already define bulk update
and delete for builder code. The card contract says update returns one row. The worker commits
step state after executing effects, so a crash can re-run a table write. The documents do not
specify how runtime table writes should behave during emulator and eval runs.

## Options

1. Use a common bot-scoped runtime adapter, operation receipts for live mutations, and read-only
   access in emulator and eval runs until isolated table data is designed.
2. Let every execution mode mutate the same tables. Emulator tests and evals could modify live
   data, and a replay could insert a second row.
3. Clone tables for every non-live conversation. This supports testing writes but requires
   lifecycle, snapshot and storage rules beyond the current table phase.

## Recommendation

Choose option 1.

- Use column names in runtime calls and row outputs, with stable IDs at the DB boundary.
  Preserve the guest row's `id` field. Reserve that column name before enabling runtime access.
  A table card uses its stored table ID. Builder code uses only the current bot's advertised
  table names. Autonomous runs expose only the operations listed on each table tool and bind its
  table ID in the worker. Builder-authored code tools use the Code card boundary.
- `find` returns an array. `get` returns the first matching row or null. Table cards route empty
  find or get through their existing not-found port. A card updates the first matching row and
  returns it, or reports a missing row. Card delete accepts a filter and has no output variable.
  Code and table tool update/delete accept a filter and return a count as the guest declaration
  describes. Keep bulk writes atomic and refuse a batch over 500 matches. Every upsert selects
  one declared unique column.
- In emulator and eval modes, permit reads and return a visible problem for mutations before any
  write. Keep Studio CRUD independent of conversation mode. Keep builder and model table code in
  the existing sandbox and route platform calls through the worker.
- Fence live mutations against the current conversation lease. Store a receipt in the same
  transaction as the table write, keyed by turn, step and call ordinal. A retry with the same
  operation and arguments gets the recorded result. A changed operation or payload at the same
  position fails explicitly. A failed transaction stores neither the result nor the write.
  Apply forced RLS and composite workspace parent keys to receipts. Retain receipts only for the
  turn's recovery window, with deletion of the associated table or turn cascading.
- Emit the existing `table.op` trace attributes (table ID, operation and row count) with no
  row data. Connect Studio's Code editor to the bot's table schema for its generated typings.

## Consequences

Emulator and eval runs can inspect data but cannot test real table mutations until an isolated
data mode is designed. Live cards, code and tools share the Table validation rules and cannot
repeat a committed mutation when a turn resumes. Integration tests should exercise all three
surfaces, duplicate receipts, a stale lease, undeclared operations and non-live writes.
