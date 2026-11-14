# Bridge webhook receiver (Node)

A minimal receiver for the Bridge API's webhooks, with no dependencies. It is the reference the
platform's own delivery tests run against (`apps/worker/test/webhook.test.ts`).

```bash
WAKEEL_SIGNING_SECRETS=whsec_your_secret PORT=8787 node src/server.mjs
```

Then set the connection's webhook URL to the public https address that reaches this server, and
use **Send test event** on the connection's Test tab.

What it does, and what any receiver must do:

1. **Verify the signature** on the raw body before parsing it (`src/verify.mjs`, the same check
   the Studio's Setup tab offers). During a secret rotation, list both secrets, newest first:
   `WAKEEL_SIGNING_SECRETS=whsec_new,whsec_old`.
2. **Ignore repeats.** Delivery is at least once; an event id seen before is answered `200` and not
   processed again. Keep processed ids in durable storage in production.
3. **Answer within 10 seconds.** Any 2xx counts as delivered. Anything else is retried after 5 s,
   30 s, 2 min, 10 min, 30 min, 2 h, 6 h and 12 h, then the event is dead and can be replayed from
   the Deliveries tab. Events of one conversation arrive in `seq` order.
