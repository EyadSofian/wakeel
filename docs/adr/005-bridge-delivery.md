# ADR-005 — Bridge: async webhooks as the base, plus sync wait and SSE

Status: accepted · Date: 2026-11-13

## Context
The Bridge API is the only channel layer. The brief asks: async webhook only, or also a sync request/response mode for simple bridges?

Forces:
- Inbox systems (Chatwoot) are event-driven and expect the bot to post replies later. Turns can take 2–30 s and may produce several messages, typing signals and a handoff.
- Simple callers (an n8n HTTP node, a script, a test) want to send text and get the answer in the response.
- The Studio emulator needs token-level liveness.
- Proactive output exists: timeouts, scheduled triggers and resumed tools produce messages with no request to answer.

## Decision
All three, over one mechanism.

1. **Async webhooks are the base and the only mode that covers every case.** Events come from a transactional outbox, are ordered per conversation by `seq`, signed with HMAC-SHA256 over `timestamp.body`, retried with backoff for about 21 hours, then dead-lettered and replayable.
2. **Sync wait** is a convenience on the inbound call: `?wait=<s>` holds the request until the turn completes and returns that turn's messages and events. On timeout the caller gets `202` and a `turnId` to poll. It is implemented as a subscriber to the same turn-completion signal; it adds no second execution path.
3. **SSE** (`Accept: text/event-stream`) streams the turn's events as they are produced. The emulator uses it; bridges may.

Rules:
- Proactive messages are only ever delivered by webhook. A connection without a webhook URL can use sync mode but will not receive them; the Studio says so on the connection page.
- When both are in use, events carry `turnId` and `eventId` for de-duplication.
- Ordering: head-of-line blocking per conversation. A dead-lettered event unblocks the stream and leaves a visible `seq` gap. Twenty consecutive dead events disable the connection.
- Ephemeral events (`typing`) are best-effort, unordered, never retried.
- Inbound idempotency by `Idempotency-Key`, 24 h.

## Alternatives considered
- **Webhook only**: forces every small integration to host an endpoint. Rejected.
- **Sync only**: cannot express proactive output or long turns. Rejected.
- **WebSocket**: bidirectional but harder for bridges and proxies; SSE plus REST covers the need.

## Consequences
- Receivers must be idempotent on `eventId`.
- A slow or failing receiver delays only its own conversations.
- The sync path holds API connections open; the `bridge` role scales separately and caps concurrent waits per connection.

## Revisit when
A bridge needs lower latency than SSE gives, or ordered delivery across conversations.
