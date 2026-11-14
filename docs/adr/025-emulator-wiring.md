# ADR-025 — Emulator wiring: draft connection, Run from here, variables

Status: proposed (implemented as proposed in task 4.6; review with that PR) · Date: 2026-11-14

## Context

Task 4.6 builds the Studio emulator. The design system (§5.3) and architecture (§1, §9.3) say the emulator is "a Bridge client in `emulator` mode streaming over SSE", with a draft connection per builder session, a user-data form, reset, a Variables tab, an error banner and "Run from here". Three things are not specified:

1. **How the Studio reaches the Bridge API.** The Studio holds a session cookie, and the Bridge API takes only bridge keys. Nothing says who creates the draft connection, or what ties it to a builder session.
2. **How "Run from here" starts a turn at a node.** The engine (§4.4) starts a conversation only at Main's Start. No inbound event names a node.
3. **Where the Variables tab reads from.** Conversation state is not in the Bridge API, by design.

## Options

**1. Transport**

- (a) A Studio endpoint mints a bridge key for the session's draft connection, and the browser calls `/v1/bridge` with it. The emulator is then a Bridge client in the most literal sense. But a bridge key lives in the browser, the endpoint must revoke and re-mint keys, and the Variables tab and Run from here still need Studio endpoints.
- (b) **Studio API routes run the Bridge inbound path in-process** for the session's draft connection: `…/bots/{botId}/emulator/…`, with the session cookie and CSRF. Each request takes the same code path as `/v1/bridge` (upsert, idempotency, inbox, enqueue, SSE). No key leaves the server, and one auth model covers every emulator call.

**2. Run from here**

- (a) **A new internal inbound kind `run_from { workflowId, nodeId }`.** The engine clears the stack, pushes a frame at that node, and runs. Only the Studio emulator route can insert it, and only on an `emulator` conversation. The Bridge API never accepts it.
- (b) A reserved custom event name (`sendEvent` with `name: "run_from"`). This puts a magic name into a public contract and lets any bridge jump into the middle of a production bot.
- (c) Write `conversations.state` directly from the API with a frame at the node. This bypasses the engine and the per-step transaction rules.

**3. Variables**

- (a) **`GET …/emulator/conversations/{externalId}/state`**, for emulator conversations of the session's draft connection only. It returns the current values by scope, keyed by variable name. Sensitive variables are replaced by a redaction marker (`variable.ts`: "never shown in the emulator variable panel"). The response also has the state's size and the 256 KB limit, for the size meter.
- (b) Put state into SSE frames. This mixes a Studio-only payload into the public event stream.

## Recommendation

1(b), 2(a) and 3(a).

**The draft connection per builder session.** Migration `0007` adds `bridge_connections.emulator_session_id`, which references `sessions (id)` with `on delete cascade` and is unique per (session, bot). The first emulator call for a bot in a session creates the connection: `target = draft`, `name = "Emulator"`, no webhook URL, no subscribed events, no keys. Signing out, or the session expiring and being removed, deletes the connection, and with it (by the existing cascades) its test users, conversations and transcripts. They are emulator data, and nothing else refers to them. The connections list (5.5) excludes rows with an `emulator_session_id`.

**Routes** (`apps/api/src/routes/emulator.ts`; permission `bot.update`, because the emulator runs the draft, including its code and model calls):

| Method and path under `/v1/workspaces/{workspaceId}/bots/{botId}/emulator` | Same as |
|---|---|
| `POST /conversations/{externalId}/messages` | `sendMessage`, SSE when `Accept: text/event-stream` |
| `PUT /users/{externalUserId}` | `updateUser` |
| `POST /conversations/{externalId}/run-from` `{ userId, user?, workflowId, nodeId }` | an inbound `run_from` event, SSE as above |
| `GET /conversations/{externalId}/state` | the Variables tab |

**Reset** is client-side. The emulator starts a new external conversation id (`emu-<ulid>`) and keeps the test user. **Run from here** always starts a new conversation the same way, so it never carries state from a run that went somewhere else.

**Engine rule for `run_from`** (§4.4 table, new row): `run_from` in any state sets status `idle` and clears the stack. It then pushes a frame for `workflowId` at `nodeId`, with that workflow's variables at their defaults, and runs. When the workflow's last node finishes, the frame pops. If that empties the stack, the status becomes `idle`, as it does when Main ends. An unknown workflow or node fails the turn with `not_found`, which names the node.

**Error banner.** The emulator turns each `error` event into a banner. The title and fix come from `errors.ts` by the event's `code`, which already holds both for every code. "Show in trace" arrives with the trace list (4.7).

## Consequences

- Contract changes: `InboundKind` gains `run_from` (`04-contracts/event.ts` and `packages/contracts`), and the `inbound_events.kind` check constraint gains it in migration `0007`.
- Architecture §4.4 gains the `run_from` row, and §9.3 notes that the emulator uses the Bridge inbound path through Studio routes.
- The emulator does not need bridge keys, CORS or a bridge role on the API process the Studio talks to.
- Emulator traffic stays `mode = emulator` (ADR-024 §5), so it is never billed or counted.
- If an external tool ever needs to drive a draft the way the emulator does, option 1(a) can still be added on top. The draft connection already exists.
