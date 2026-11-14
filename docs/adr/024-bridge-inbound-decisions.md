# ADR-024 — Bridge inbound: the decisions the contract leaves open

Status: accepted (Eyad delegated these decisions in chat on 2026-11-14; implemented in task 4.5, #51) · Date: 2026-11-14

## Context

Task 4.5 built the inbound half of the Bridge API from architecture §4.2, §9.1, §9.3 and `04-contracts/bridge-api.openapi.yaml`. Eight questions came up that those documents do not answer, or answer only in part. The 4.5 PR listed seven and asked for a ruling; Eyad asked the executor to decide. The eighth (`externalMessageId`) turned up while the seven were being decided: the contract promises it and 4.5 did not build it.

Each section below gives the question, the options and the decision. They all apply from task 4.5 on.

## 1. Where the `turnId` in a `202` comes from

The contract's `Accepted` body requires `turnId`, but under §4.3 the worker creates the turn row later, and may coalesce several events into one turn.

- Options: (a) the API mints the id when it accepts the event and the worker starts the turn under it; (b) drop `turnId` from `Accepted` (a contract change that breaks `GET /turns/{turnId}` polling after a `wait` timeout); (c) make `turnId` the inbound event id.
- **Decision: (a).** The API mints `turn_…`, stores it on the inbound event (`payload.turnId`), and the worker starts the turn with that id.
- If the event is coalesced into an earlier event's turn, the promised id never becomes a turn row. `GET /turns/{promisedId}` then returns the turn that handled the event, and `TurnResult.turnId` is that turn's id. A caller that de-duplicates webhooks should use the `turnId` in events, not the one in the `202`.
- Before the worker starts the turn, `GET /turns/{promisedId}` answers `status: running` with no messages.

## 2. Where user profile fields live

`UserData` has `name`, `email`, `phone` and `locale`; `end_users` has no columns for them. §9.1 says user data "is merged into `end_users.attributes`", and §4.5 exposes bridge data to the bot only as `user.attributes`.

- Options: (a) store them as keys in `attributes`; (b) add columns (a migration, and a second place the bot reads from).
- **Decision: (a).** The four fields are merged into `attributes` under their own names. The bot reads `user.attributes.name`. `User` responses also return them as top-level fields, read from `attributes`. A field set in both `attributes` and at the top level takes the top-level value.

## 3. How long an `Idempotency-Key` is honoured

§9.1 and the OpenAPI file say 24 hours. The key is kept in a unique column on `inbound_events`, so a repeat after 24 hours still replays.

- Options: (a) expire keys after 24 hours with a janitor that clears the column; (b) keep them as long as the event exists.
- **Decision: (b).** The guarantee is "at least 24 hours". A replay after 24 hours returns the original response, which is what a retrying caller wants anyway; expiry would only add a way to store a message twice. Keys are deleted with their event when conversation retention removes it (Phase 10).
- §9.1 and the `Idempotency-Key` parameter description now say "at least 24 hours".

## 4. Event ids

The OpenAPI file fixes the format (`evt_` + 26 characters) but not where the value comes from.

- **Decision:** `evt_` followed by the outbox row's ULID. The id is the same on every delivery attempt and on a replay of a dead event, so `X-Wakeel-Event-Id` de-duplicates across retries, `wait`, SSE and webhooks.

## 5. Draft connections

A connection with `target: draft` runs the bot's draft (§3.2).

- **Decision:** conversations created through a draft connection have `mode = emulator`. They are never billed, counted or rate-limited as live conversations (CLAUDE.md §9, §13). The emulator (4.6) uses one draft connection per builder session.

## 6. A conversation and its user

The contract requires `userId` on the first message and is silent on later ones.

- Options: (a) a conversation keeps the user that started it, and a different `userId` is refused; (b) the conversation moves to the new user; (c) the new user is ignored.
- **Decision: (a).** A later message may omit `userId`. One that names another user is `validation_failed` with `{ path: "userId", code: "user_mismatch" }`. Moving a conversation between users silently would mix two people's `user` variables; ignoring the field would hide a bridge bug.

## 7. What `paused` means for a connection

`BridgeConnection.status` is `active | paused | disabled`. No document defines `paused`.

- Options: (a) `paused` holds outbound webhook deliveries, while inbound calls and turns go on; (b) `paused` refuses inbound calls like `disabled`; (c) `paused` accepts inbound calls but runs no turns.
- **Decision: (a).** `paused` is for a receiver under maintenance: inbound messages keep being answered (`wait` and SSE still work), and the outbox keeps filling. Deliveries wait in order and resume when the connection is `active` again, with no gap. `disabled` refuses inbound calls with `connection_disabled` and also holds deliveries. Twenty consecutive dead events still set `disabled` (§9.2).
- The delivery worker (5.2) implements the hold. Studio (5.5) labels the action "Pause deliveries".

## 8. `externalMessageId` without an `Idempotency-Key`

The OpenAPI file says `externalMessageId` is "used for de-duplication when no `Idempotency-Key` is sent". 4.5 stored it but did not de-duplicate by it.

- Options: (a) derive a key from it and use the existing idempotency path; (b) add a unique index on `messages (conversation_id, external_id)` with its own replay logic (a migration and a second code path).
- **Decision: (a).** With no `Idempotency-Key`, the key is `xmid:` + base64url SHA-256 of the conversation's external id (length-prefixed) and the `externalMessageId` (`packages/bridge` `externalMessageKey`). It is stored in the same per-connection column and follows the same rules: the same body replays the first response, a different body is `idempotency_mismatch`. A message id is scoped to its conversation, because channels number messages per chat. An explicit `Idempotency-Key` takes precedence. Events have no `externalMessageId` and are de-duplicated only by `Idempotency-Key`.

## Consequences

- Architecture §9.1 and the OpenAPI descriptions of `Idempotency-Key`, `externalMessageId` and `BridgeConnection.status` are updated to match (this PR).
- 5.2 must hold deliveries for `paused` and `disabled` connections and resume them in order.
- If `name`, `email`, `phone` or `locale` ever need indexing or search, columns can be added then with a backfill from `attributes`; the API shape stays the same.
- Conversation retention (Phase 10) must delete inbound events, and their keys with them, so the key table does not grow without bound.
