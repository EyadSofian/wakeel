# Chatwoot adapter

Connects a Chatwoot agent bot to a bot's bridge connection (build-plan Phase 14,
`docs/04-contracts/chatwoot-adapter-spec.md`). It uses only the public Bridge API.

```
Customer ⇄ Chatwoot inbox ──agent bot webhook──▶ /chatwoot/<pair>/webhook ──Bridge API──▶ platform
                    ▲                                                                       │
                    └──── Chatwoot REST API ◀── /bridge/<pair>/webhook ◀── signed webhook ───┘
```

## Configuration

| Variable | Meaning |
|---|---|
| `ADAPTER_PAIRS` | JSON array of pairs (below). Secret: holds tokens. |
| `REDIS_URL` | Optional. De-duplication and numbered-list state survive restarts and scale out. Without it, state is in memory. |
| `PORT` | Default 4600. |

A pair:

```json
{
  "id": "16-64 random URL-safe characters",
  "chatwootBaseUrl": "https://chat.example.com",
  "chatwootAccountId": 2,
  "chatwootToken": "agent bot or agent access token",
  "bridgeBaseUrl": "https://your-platform-origin",
  "bridgeKey": "wk_bridge_…",
  "bridgeSigningSecrets": ["whsec_…"],
  "handoffTeamId": 2,
  "greetFirst": false,
  "autoResolve": false
}
```

The pair id is part of both webhook URLs, so it also authenticates Chatwoot's webhook: generate it
with `openssl rand -hex 16` and keep it out of logs.

## Setup

1. In the Studio, add a bridge connection to the bot. Webhook URL:
   `https://<adapter>/bridge/<pair id>/webhook`. Keep its bridge key and signing secret.
2. In Chatwoot, Settings → Bots → add an agent bot with webhook URL
   `https://<adapter>/chatwoot/<pair id>/webhook`, then choose it in the inbox's Bot configuration.
   New conversations in that inbox start as `pending`, which is what the bot answers.
3. Set `ADAPTER_PAIRS` and start the service (`apps/adapter-chatwoot/Dockerfile`).

## Behaviour

- Incoming contact messages (text, images, files, locations) and picked `input_select` options go to
  the platform with idempotency keys `cw-msg-<id>` / `cw-sel-<id>`. Messages are forwarded even while
  a human has the conversation, so the transcript stays complete; the platform keeps the bot silent.
- Bot text, choices (as `input_select`, or a numbered list on channels without it, where a reply of
  `2` or `٢` picks the option), cards and links go back to the conversation.
- `handoff.requested`: private note with the reason and summary, status `open`, team or agent
  assignment, label `bot-handoff`. Setting the conversation back to `pending` releases the handoff;
  `resolved` ends it.
- Webhooks from the platform are verified (HMAC-SHA256, 300 s window, both secrets during a rotation)
  and de-duplicated for 24 hours. Chatwoot failures answer 502 so the platform retries in order.
- If the platform cannot be reached after five attempts, the conversation gets a private note and is
  opened for a human.

## Not done yet

- Images and files from the bot are sent as links, not uploaded as Chatwoot attachments.
- Spec §7 test 4 (docker-compose with a real Chatwoot) and the spec's ⚠ field checks against a
  recorded webhook capture are task 14.1 and 14.3.
