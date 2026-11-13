# Reference adapter spec: Chatwoot Agent Bot ↔ Bridge API

Status: specification only. The adapter is built in Phase 14. It is a separate small service (`apps/adapter-chatwoot`) and a consumer of the public Bridge API: it gets no private access.

**Verification note.** Chatwoot field names below come from Eyad's working bridge and from prior knowledge of the Chatwoot API. The Chatwoot docs could not be fetched while this spec was written. Before implementing, re-check every field marked ⚠ against https://developers.chatwoot.com and a real webhook capture from Eyad's instance, and record the capture as a test fixture.

## 1. Topology

```
Customer ⇄ Chatwoot inbox ──(agent bot webhook)──▶ adapter ──(Bridge API)──▶ platform
                    ▲                                 ▲                          │
                    └──────(Chatwoot REST API)────────┴──────(signed webhook)────┘
```

One adapter instance serves many pairs of (Chatwoot account + agent bot) ↔ (bridge connection). Each pair is a row in the adapter's own config:

| Field | Meaning |
|---|---|
| `id` | Random slug; appears in both webhook URLs |
| `chatwootBaseUrl` | e.g. `https://chat.engosoft.com` |
| `chatwootAccountId` | Numeric account id |
| `chatwootBotToken` | The agent bot's access token (sent as `api_access_token`) ⚠ |
| `bridgeKey` | `wk_bridge_…` |
| `bridgeSigningSecret` | For verifying our webhooks |
| `handoffTeamId?` / `handoffAssigneeId?` | Where to route on handoff |
| `chatwootWebhookSecret?` | If the Chatwoot version signs webhooks ⚠; otherwise the URL slug is the secret |

## 2. Id mapping

| Bridge | Chatwoot |
|---|---|
| `externalConversationId` | `cw-<accountId>-<conversation.id>` |
| `userId` | `cw-<accountId>-contact-<sender.id>` |
| `externalMessageId` | `cw-msg-<message.id>` |

No padding or hashing. The Bridge API accepts any URL-safe id up to 255 characters.

## 3. Chatwoot → platform

Endpoint: `POST /chatwoot/<id>/webhook`. Always answer `200` quickly; do the work asynchronously.

| Chatwoot event ⚠ | Condition | Action |
|---|---|---|
| `message_created` | `message_type == "incoming"` and conversation `status == "pending"` | `sendMessage` (see mapping) with `Idempotency-Key: cw-msg-<id>` |
| `message_created` | `message_type == "incoming"` and `status == "open"` | Still `sendMessage`: the platform stores it and stays silent while handed off. This keeps the transcript complete for when the bot resumes. |
| `message_created` | outgoing, activity or private note | Ignore |
| `conversation_status_changed` | to `pending` from `open` | `releaseHandoff` with `note` = last private note if available |
| `conversation_status_changed` | to `resolved` | `endConversation` |
| `conversation_created` / `webwidget_triggered` | — | `sendEvent { name: "conversation_started" }` only if the pair is configured to greet first |

Message mapping:

| Chatwoot content | Bridge message |
|---|---|
| Plain text | `{ type: "text", text, format: "plain" }` |
| Reply to an `input_select` ⚠ (`content_attributes.submitted_values[0].value`) | `{ type: "postback", value, label: title }` |
| Attachment `file_type == "image"` | `{ type: "image", url: data_url }` |
| Other attachment | `{ type: "file", url: data_url, name }` |
| Attachment `file_type == "location"` | `{ type: "location", latitude, longitude }` |
| Text + attachments | One Bridge call per part, text first, each with its own idempotency key suffix |

User data on every call: `user.name` = `sender.name`, `user.email`, `user.phone` = `sender.phone_number`, `user.attributes` = `{ chatwootContactId, inboxId, channel, ...sender.custom_attributes }`.

The adapter uses plain `202` (no `wait`). Replies arrive by webhook.

## 4. Platform → Chatwoot

Endpoint: `POST /bridge/<id>/webhook`. Verify the signature (timestamp tolerance 300 s, constant-time compare, both `v1` values). De-duplicate on `X-Wakeel-Event-Id` for 24 h. Return `2xx` only after the Chatwoot call succeeded, so the platform's retry and ordering apply end to end. Return `5xx` on Chatwoot failure.

Chatwoot call for messages: `POST /api/v1/accounts/{accountId}/conversations/{conversationId}/messages` with header `api_access_token` ⚠.

| Bridge event | Chatwoot action |
|---|---|
| `message.created` text | `{ content, message_type: "outgoing" }`. Markdown is sent as-is (Chatwoot renders a subset). |
| `message.created` choice / dropdown | `{ content: text, content_type: "input_select", content_attributes: { items: [{ title: label, value }] } }` ⚠. On channels where Chatwoot does not render `input_select` (the adapter keeps an allow-list by `channel`), send a numbered list as text and remember the mapping `n → value` for that conversation for 24 h; a reply of just that number becomes a `postback`. |
| `message.created` card / carousel | `{ content_type: "cards", content_attributes: { items: [{ title, description: subtitle, media_url: imageUrl, actions: [{ type: "link"|"postback", text: label, uri|payload }] }] } }` ⚠. `say` actions become `postback` with the say text as payload. Fallback: text with title, subtitle and links. |
| `message.created` image / file | Multipart upload with `attachments[]` fetched from `url`, `content` = caption or file name |
| `message.created` location | Text with a maps link |
| `message.created` custom | Ignored unless `name == "chatwoot"`: then `data` is posted as the message body verbatim |
| `typing` | `POST …/conversations/{id}/toggle_typing_status` with `typing_status: "on"\|"off"` ⚠; errors ignored |
| `handoff.requested` | 1. Private note with `reason` and `summary`. 2. `POST …/conversations/{id}/toggle_status` `{ status: "open" }` ⚠. 3. If configured, `POST …/assignments` with `team_id` or `assignee_id` ⚠. 4. Add label `bot-handoff`. |
| `conversation.ended` reason `completed` | `toggle_status { status: "resolved" }` if the pair is configured to auto-resolve; otherwise nothing |
| `conversation.ended` reason `inactivity` | Nothing |
| `error` | Private note with `code` and `message`; if `retryable` is false, perform the handoff steps so a human sees it |
| `turn.completed` | Nothing |

## 5. Handoff life cycle

```
bot active (Chatwoot status: pending)
   │  bot emits handoff.requested
   ▼
adapter: note + status → open (+ assignment)          platform: conversation handed_off, bot silent
   │  agent works; customer messages are forwarded and stored, bot does not reply
   ▼
agent sets status → pending (or resolves)
   │  adapter: releaseHandoff (or endConversation)
   ▼
bot active again; no flags to reset by hand
```

## 6. Failure behaviour

- Chatwoot → adapter → platform: retry Bridge calls with the same idempotency key (5 attempts, backoff). After that, post a private note "The assistant is unavailable" and set status `open`.
- Platform → adapter → Chatwoot: rely on platform retries (return `5xx`).
- Adapter restarts: stateless except the 24 h de-duplication set and numbered-list mappings (Redis).

## 7. Acceptance tests (Phase 14)

1. Recorded Chatwoot webhook fixtures produce the expected Bridge requests (golden files).
2. Each Bridge event type produces the expected Chatwoot API call against a mock server.
3. A tampered signature, an old timestamp and a replayed event id are each rejected or ignored.
4. End to end with docker-compose (Chatwoot + platform + adapter): customer message → bot reply; handoff → agent reply → status back to pending → bot replies again.
5. Arabic text, an RTL message with an English product code, and an emoji round-trip unchanged.
