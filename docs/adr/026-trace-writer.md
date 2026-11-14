# ADR-026 — The minimal trace writer: where spans come from, how they stay correct, how the Studio reads them

Status: proposed (implemented as proposed in task 4.7; review with that PR) · Date: 2026-11-14

## Context

Task 4.7 builds the minimal trace writer (turn, node, card, code and error spans, inline payloads only) and the emulator's trace list with the canvas run overlay. Architecture §12, ADR-009 and `04-contracts/trace.ts` fix the span shapes and the storage, but leave six things open:

1. **Who builds the spans.** The engine is pure and commits one `StepCommit` per step (§4.4). The commit has no timings, no card type and no variable diff.
2. **How a span stays correct across a resumed turn.** A step that crashed is run again (§4.4), and a node or turn span covers many steps.
3. **Span ids.** `SpanId` is a ULID-shaped id, and the docs say nothing about retries.
4. **Partitions.** `trace_spans` is "range-partitioned monthly", but nothing creates future partitions.
5. **How the Studio reads a trace.** `Trace` names `GET …/turns/{turnId}/trace` without a full path, and §12 says "emulator spans stream over SSE as they are written".
6. **Two turn triggers have no value.** `attrs.turn.trigger` has no value for the `run_from` (ADR-025) and `user_update` inbound kinds.

## Decisions

**1. The worker builds spans from the step commits** (`packages/telemetry/src/trace.ts`, a pure `TraceBuilder`).
- The turn worker already has the definition, the clock and each commit. It feeds the builder `turnStarted`, `stepCommitted(commit, before, at)` and `turnFinished(result, at)`, and writes the spans the builder returns.
- A card span runs from the end of the previous step to this commit. That is the step's own run time, since steps run back to back.
- The card type comes from the definition at the step's location.
- `writes` is the diff of conversation, workflow (top frame) and user variables between the state before and after. Sensitive variables are diffed as `"[redacted]"` (ADR-009: redaction before write).
- A card of type `code` also gets a `code.exec` child, with its source and the step's logs as inline payloads.
- Each failure in the commit gets an `error` span under the card (or node), with the code, the message, the fix from `errors.ts`, and `handledBy`.
- The engine does not change.

**2. Spans are written when they start and updated when they end.**
- The turn span (seq 0) is written at turn start. A node span is written when the turn enters the node.
- Both are updated with their duration, status and closing attributes when the node is left or the turn ends.
- The UI can therefore show a row as soon as it starts (§5.3, "Trace, live").
- On a resumed turn, the builder is given the spans already stored for that turn. It continues their seq, skips ids it has already written, and treats the last node span without `leftBy` as the open node.
- The writer upserts by span id. A failed write is logged and counted, and the turn goes on (ADR-009).

**3. Span ids are derived:** `span_` + a hash of `turnId:seq`, through `packages/contracts/src/ids.ts` (`derivedId`). A re-run step gets the same seq and so the same id, and the resume dedupe in decision 2 drops it.

**4. Partitions.**
- Migration `0008` creates `trace_spans` partitioned by month on `started_at`, a `default` partition and the months from 2026-11 to 2027-06.
- The primary key is `(id, started_at)`, as Postgres requires for partitioned tables.
- RLS is enabled and forced on the parent, and only the parent is granted to `app_rw`.
- Creating months ahead and dropping old ones (retention, §12) belongs to the retention work in Phase 10. Until then the default partition catches anything outside the created months.

**5. Reading traces.**
- `GET /v1/workspaces/{workspaceId}/turns/{turnId}/trace` returns `Trace` (spans ordered by seq) and needs `conversation.read`. The Conversations screen (Phase 10) can reuse it.
- The **emulator's** SSE stream, and only that one (ADR-025 Studio routes), also carries `trace.span` frames with the `Span` as data, interleaved with the Bridge events as they are written. An updated span is sent again under the same id.
- The public Bridge API never sends spans.

**6. Turn triggers.** `attrs.turn.trigger` gains `run_from` and `user_update`, so every inbound kind maps to one. This is a correction, not a new field.

## Consequences

- Contract changes: `trace.ts` turn triggers, and `derivedId` in `ids.ts`.
- New: migration `0008`, a repository for spans, and the read endpoint.
- Each step does one more write after its commit. It sits outside the step transaction, so a failing trace store never blocks or rolls back a turn.
- Payloads are inline only for now. Anything over 8 KB is cut to a 400-character preview, marked `inline: false` with `key: ""` and its true size. The object store path (ADR-009) arrives with the first producer of large payloads, the Autonomous Node in Phase 6.
- Turn playback (▶, ⏭, §5.3 "Trace playback") reads the same spans and is left for a later task. 4.7 shows the live list and the run overlay.
