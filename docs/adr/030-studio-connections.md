# ADR-030 — Managing connections in the Studio

Status: proposed (implemented as proposed in task 5.5; review with that PR) · Date: 2026-11-14

## Context

Task 5.5 builds the Connections screens (design system §5.11): a list with status and last delivery, and a detail with Setup, Deliveries and Test tabs. The Bridge API (ADR-005, ADR-029) is what a bridge calls with its own key. The Studio needs routes that a builder calls with their session. The docs leave these open:

1. **The Studio's routes for connections**, their permissions and audit entries.
2. **How the signing secret is shown.** It is stored encrypted (ADR-028 §7), so it could be shown at any time. API keys are shown once (task 1.4).
3. **Where "send a message as a user" in the Test tab runs**, and whether that traffic counts as live (CLAUDE.md §9: emulator and eval traffic is never billed or counted as live).
4. **Which webhook URLs are accepted.** `webhook_url_blocked` says "Use a public https address".
5. **How the E2E test reaches a local receiver.** The plan says "send a test event to a local receiver", but egress blocks loopback and private addresses (ADR-020), and that policy must not get an exception.

## Decision

1. **Routes** under `/v1/workspaces/:workspaceId/bots/:botId/connections`. They use the builder's session with CSRF, as every Studio route does. Reads need `connection.read`; writes need `connection.manage`; each write writes one audit entry.
   - `GET` lists the bot's connections, newest first, with `lastDelivery { status, at } | null`. The emulator's own connections (ADR-025) are not listed.
   - `POST { name, target, webhookUrl?, subscribedEvents }` creates a connection with one signing secret (`connection.created`).
   - `GET /:connectionId` and `PATCH /:connectionId { name?, target?, webhookUrl? (null clears it), subscribedEvents?, status? }` (`connection.updated`).
     - `status` accepts `active` or `paused`.
     - Setting `active` on a `disabled` connection turns it back on and resets `consecutive_dead` (`connection_disabled` tells the builder to do exactly this).
   - `GET /:connectionId/keys`, `POST /:connectionId/keys { name }` and `DELETE /:connectionId/keys/:keyId` manage bridge keys through the task 1.4 key code (`api_key.created`, `api_key.revoked`, with the connection as target).
   - `POST /:connectionId/signing-secrets/rotate` adds a new secret and keeps the previous one, so both are sent (§9.2) (`connection.secret_rotated`). `POST /:connectionId/signing-secrets/finish-rotation` keeps only the newest.
   - `GET /:connectionId/deliveries`, `POST /:connectionId/deliveries/:eventId/replay` and `POST /:connectionId/test` behave exactly like `listDeliveries`, `replayDelivery` and `testWebhook` (ADR-029), and share their code.
   - `POST /:connectionId/test/messages { text }` runs the inbound path for this builder's test conversation on the connection and answers like `?wait`.
2. **A signing secret is shown once**, in the response that creates it (create, rotate), like API keys. Afterwards only its last four characters are shown. A builder who lost it rotates. This keeps the plaintext out of every later response and log.
3. **Test-tab messages are emulator traffic.**
   - Their conversation is `studio-test-<sessionId>` on the chosen connection, with mode `emulator` even on a production connection, so it is never billed or counted as live.
   - Its webhook deliveries are still made: seeing them arrive is the point of the Test tab.
4. **Webhook URLs must be `https`**, at most 2048 characters, with no user name or password. They can't be an IP literal in a loopback, private, link-local or metadata range, or `localhost`. Anything else is `webhook_url_blocked`.
   - Hostnames are checked by egress at send time (DNS can change; ADR-020).
   - The check runs on create and update. It is a convenience: egress stays the enforcement point.
5. **The E2E test uses an egress stand-in, not an egress exception.**
   - For the E2E run, the API and the worker get `EGRESS_URL` pointing at `apps/studio/e2e/egress-stand-in.ts`. It speaks the egress wire format (ADR-020) and forwards `https://receiver.e2e.test/...` to a local HTTP receiver.
   - Production egress is unchanged. The real egress path is covered by egress's own suites and was exercised by hand in task 5.2.
   - The E2E test makes a delivery dead by updating its row (through `withWorkspace`), since waiting out 21 hours of retries is not possible.

## Consequences

- The bot's rail gains Connections, after Conversations (design system §5.1 lists the rail's destinations; §5.11 did not place the screen).

- New audit actions: `connection.created`, `connection.updated`, `connection.secret_rotated`.
- `bridge_connections` gains no columns: the last four characters of a secret are read by opening it.
- The Bridge API's `testWebhook`, delivery list and replay move into a shared module used by both route sets.
