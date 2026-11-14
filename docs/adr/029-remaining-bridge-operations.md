# ADR-029 — The remaining Bridge operations: ending, tool results, replay and the test event

Status: proposed (implemented as proposed in task 5.3; review with that PR) · Date: 2026-11-14

## Context

Task 5.3 adds `listConversationEvents`, `listDeliveries`, `replayDelivery`, `getConnection`, `testWebhook`, `endConversation` and `submitToolResult` (plumbing only). The OpenAPI file fixes their paths and bodies, but leaves these open:

1. **How `endConversation` changes state.** It answers `200` with the conversation, but a turn may hold the conversation's lease (§4.3), and the engine's event table (§4.4) has no row for a manual end.
2. **When `submitToolResult` is refused.** It documents `409` without saying when, or what code the refusal has.
3. **What a replay is.** "Sent out of order with its original `seq` and `id`" conflicts with ADR-028's stream: a pending row with a `seq` would become the head and block newer events. The docs also don't say whether a replay is retried, or what happens when an event is not dead or failed.
4. **What the test event carries.** Every `BridgeEvent` names a conversation and a user, and a connection test has neither.
5. **What `Delivery` lists.** `webhook_deliveries` has one row per attempt (ADR-028); the `Delivery` schema has one `status` and one `attempt`.

## Decision

1. **`endConversation` goes through the inbox as a new inbound kind, `end`.**
   - The engine's row: in any state except `ended`, end the conversation with reason `manual`, which clears the stack and any wait or handoff, keeps user variables and emits `conversation.ended { reason: "manual" }`. In `ended`, nothing happens.
   - The API inserts the event, enqueues the turn and waits for it, like `?wait` (up to 55 s), then answers `200` with the conversation.
   - If the turn has not finished by then, it answers `200` with the conversation as stored: its `status` shows it is not `ended` yet.
   - Going through the inbox keeps the lease and per-step transactions as the only way state changes (§4.3), and keeps events in order behind a turn that is running.
   - Migration `0010` adds `end` to the `inbound_events.kind` check; `InboundKind` and the trace trigger enum gain `end`.
   - `endConversation` on an unknown conversation is `404`.
2. **`submitToolResult` is refused with `409 tool_call_not_pending`** when the conversation is not `waiting_external` or its pending `toolCallId` differs from the request's. The check runs in the request's transaction. The engine's own check (§4.4: a result for another call is ignored) stays as the backstop for a race.
   - Accepted results become a `tool_result` inbound event, `{ toolCallId, result | error }`, honouring `Idempotency-Key`.
   - The response is `202 Accepted` with `status: "queued"`.
3. **A replay is a single out-of-band attempt.**
   - `replayDelivery` adds a pending row marked `replay = true`, with attempt = last attempt + 1. Migration `0010` adds the column, default `false`.
   - The delivery worker sends replay rows with the ephemeral ones, outside the ordered head, so newer events are not blocked.
   - A failed replay is recorded as `failed` and not retried; the builder can replay again. A replay never changes `consecutive_dead`.
   - Only an event whose latest attempt is `dead` or `failed` (with no pending attempt) can be replayed. Anything else is `409 delivery_not_replayable`. The OpenAPI file gains that `409`.
   - A replay on a paused or disabled connection waits like everything else (ADR-028 §8).
4. **The test event is a signed, ephemeral `turn.completed` that is not stored.**
   - It names a fixed test conversation and user, `{ id: "conv_00000000000000000000000000", externalId: "wakeel_test" }` and `{ id: "eu_00000000000000000000000000", externalId: "wakeel_test" }`, and `data: { status: "completed", messageCount: 0, durationMs: 0 }`.
   - It is sent the same way as real deliveries: through egress, signed with every active secret, 10 s, no redirects.
   - The answer: `{ delivered, statusCode?, durationMs, error? }`, where `error` is a code from `errors.ts`. A connection with no URL or no secret answers `200` with `delivered: false` and `error: "webhook_secret_missing"`, without sending.
   - To do this, the egress sender moves from the worker to `packages/bridge` (`delivery.ts`): both the API and the worker use it, and apps do not import apps.
5. **`listDeliveries` lists events, not attempts.**
   - One item per event of the key's connection, from its latest attempt: `status`, `attempt`, `nextAttemptAt` (pending only), `responseStatus`, `error` (the code), `seq`, `conversationId`, `eventId`, `eventType`.
   - Newest event first; `?status=` filters on the latest attempt's status. The cursor is opaque and encodes `(created_at, outbox id)`.
6. **`listConversationEvents`** returns the conversation's ordered events with `seq > after`, ascending, up to `limit`, as `BridgeEvent`s (the same envelope as webhooks). Ephemeral events are never listed.
7. **New error codes:** `tool_call_not_pending` (409) and `delivery_not_replayable` (409).

## Consequences

- The API now needs `EGRESS_URL`, `EGRESS_TOKEN` and `MASTER_KEY` (for `testWebhook`). It fails at start naming any that is missing.
- `releaseHandoff` stays with task 5.4.
- The API serves every operation in the OpenAPI file except `releaseHandoff` (task 5.4) and `receiveBridgeEvent`, which is the webhook a receiver implements.
