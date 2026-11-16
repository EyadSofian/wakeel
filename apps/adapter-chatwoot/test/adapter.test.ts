import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { AdapterConfig } from "../src/config";
import type { HttpCall } from "../src/http";
import { createAdapterServer } from "../src/server";
import { memoryStore } from "../src/store";
import { signBody } from "../src/verify";

/**
 * Phase 14.2 acceptance (chatwoot-adapter-spec §7, tests 1–3 and 5) against in-process fakes: no
 * network, fixed clock. Webhook fixtures follow the agent-bot payloads captured from the Engosoft
 * instance; every value is synthetic.
 */

const SECRET = "whsec_test_secret";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const PAIR_ID = "majed-test-pair-0001";

const config = (over: Record<string, unknown> = {}) =>
  AdapterConfig.parse({
    pairs: [
      {
        id: PAIR_ID,
        chatwootBaseUrl: "https://chat.example.test/",
        chatwootAccountId: 2,
        chatwootToken: "cw-token-canary",
        bridgeBaseUrl: "https://wakeel.example.test",
        bridgeKey: "wk_bridge_canary",
        bridgeSigningSecrets: [SECRET],
        handoffTeamId: 9,
        ...over,
      },
    ],
  });

type Call = Parameters<HttpCall>[0];
const servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(opts: { status?: (call: Call) => number; pair?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const pending: Promise<void>[] = [];
  const logs: string[] = [];
  const store = memoryStore(() => NOW);
  const http: HttpCall = async (call) => {
    calls.push(call);
    return { status: opts.status?.(call) ?? 202, body: {} };
  };
  const server = createAdapterServer({
    config: config(opts.pair),
    store,
    http,
    now: () => NOW,
    sleep: async () => {},
    log: (level, msg, data) => logs.push(`${level} ${msg} ${JSON.stringify(data ?? {})}`),
    defer: (w) => pending.push(w),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const settle = async () => {
    await Promise.all(pending.splice(0));
  };
  const chatwoot = async (body: unknown) => {
    const res = await fetch(`${base}/chatwoot/${PAIR_ID}/webhook`, { method: "POST", body: JSON.stringify(body) });
    await settle();
    return res.status;
  };
  const bridge = async (event: unknown, sign: (raw: Buffer) => string = (raw) => signBody(raw, SECRET, NOW / 1000)) => {
    const raw = Buffer.from(JSON.stringify(event));
    const res = await fetch(`${base}/bridge/${PAIR_ID}/webhook`, {
      method: "POST",
      body: raw,
      headers: { "x-wakeel-signature": sign(raw) },
    });
    return res.status;
  };
  return { calls, logs, store, chatwoot, bridge, base };
}

const contact = {
  id: 77,
  name: "مهندس أحمد",
  email: "ahmed@example.test",
  phone_number: "+201000000000",
  type: "contact",
  custom_attributes: { activeCourse: "HVAC" },
};
const incoming = (over: Record<string, unknown> = {}) => ({
  event: "message_created",
  id: 501,
  content: "عايز كورس HVAC من فضلك 👍",
  message_type: "incoming",
  content_type: "text",
  content_attributes: {},
  private: false,
  sender: contact,
  inbox: { id: 18, name: "test" },
  conversation: { id: 900, status: "pending", channel: "Channel::WebWidget", inbox_id: 18 },
  account: { id: 2 },
  ...over,
});

const envelope = (type: string, data: unknown, id = "evt_01m7gxdey4gehxa8njzgyc22e0") => ({
  id,
  apiVersion: "2026-11-01",
  createdAt: "2026-11-16T12:00:00.000Z",
  connectionId: "conn_01m7aaaaaaaaaaaaaaaaaaaaaa",
  botId: "bot_01m7aaaaaaaaaaaaaaaaaaaaaa",
  conversation: { id: "conv_01m7aaaaaaaaaaaaaaaaaaaaaa", externalId: "cw-2-900" },
  user: { id: "eu_01m7gxdey5zyx83d1jz8s3w3yz", externalId: "cw-2-contact-77" },
  seq: 3,
  ephemeral: false,
  type,
  data,
});
const botMessage = (payload: unknown) =>
  envelope("message.created", {
    message: {
      id: "msg_01m7aaaaaaaaaaaaaaaaaaaaaa",
      conversationId: "conv_01m7aaaaaaaaaaaaaaaaaaaaaa",
      seq: 4,
      direction: "out",
      payload,
      citations: [],
      createdAt: "2026-11-16T12:00:00.000Z",
    },
  });

describe("Chatwoot → platform", () => {
  test("an incoming Arabic message becomes one sendMessage with ids, user data and an idempotency key", async () => {
    const a = await start();
    expect(await a.chatwoot(incoming())).toBe(200);
    expect(a.calls).toHaveLength(1);
    const [call] = a.calls;
    expect(call?.url).toBe("https://wakeel.example.test/v1/bridge/conversations/cw-2-900/messages");
    expect(call?.headers).toEqual({ authorization: "Bearer wk_bridge_canary", "idempotency-key": "cw-msg-501" });
    expect(call?.body).toEqual({
      userId: "cw-2-contact-77",
      user: {
        name: "مهندس أحمد",
        email: "ahmed@example.test",
        phone: "+201000000000",
        attributes: {
          activeCourse: "HVAC",
          contactName: "مهندس أحمد",
          contactEmail: "ahmed@example.test",
          contactPhone: "+201000000000",
          chatwootContactId: 77,
          chatwootConversationId: 900,
          inboxId: 18,
          channel: "Channel::WebWidget",
        },
      },
      metadata: { chatwootStatus: "pending" },
      message: { type: "text", text: "عايز كورس HVAC من فضلك 👍", format: "plain" },
      externalMessageId: "cw-msg-501",
    });
  });

  test("outgoing messages, private notes and agent messages are ignored", async () => {
    const a = await start();
    await a.chatwoot(incoming({ message_type: "outgoing" }));
    await a.chatwoot(incoming({ private: true }));
    await a.chatwoot(incoming({ sender: { ...contact, type: "user" } }));
    await a.chatwoot({ event: "contact_updated", id: 1 });
    expect(a.calls).toEqual([]);
  });

  test("text plus attachments: text first, then one call per attachment with its own key", async () => {
    const a = await start();
    await a.chatwoot(
      incoming({
        attachments: [
          { id: 1, file_type: "image", data_url: "https://chat.example.test/a.png" },
          { id: 2, file_type: "file", data_url: "https://chat.example.test/cv.pdf", fallback_title: "cv.pdf" },
          { id: 3, file_type: "location", coordinates_lat: 30.04, coordinates_long: 31.23 },
        ],
      }),
    );
    expect(
      a.calls.map((c) => [c.headers["idempotency-key"], (c.body as { message: { type: string } }).message.type]),
    ).toEqual([
      ["cw-msg-501", "text"],
      ["cw-msg-501-a1", "image"],
      ["cw-msg-501-a2", "file"],
      ["cw-msg-501-a3", "location"],
    ]);
  });

  test("a picked input_select option becomes a postback", async () => {
    const a = await start();
    await a.chatwoot(
      incoming({
        event: "message_updated",
        id: 600,
        message_type: "outgoing",
        sender: { id: 1, type: "agent_bot" },
        conversation: { id: 900, status: "pending", channel: "Channel::WebWidget", meta: { sender: contact } },
        content_attributes: { submitted_values: [{ title: "مجالات التدريب", value: "fields" }] },
      }),
    );
    expect(a.calls[0]?.body).toMatchObject({
      userId: "cw-2-contact-77",
      message: { type: "postback", value: "fields", label: "مجالات التدريب" },
    });
    expect(a.calls[0]?.headers["idempotency-key"]).toBe("cw-sel-600");
  });

  test("status pending releases the handoff and resolved ends the conversation", async () => {
    const a = await start();
    await a.chatwoot({ event: "conversation_status_changed", id: 900, status: "pending" });
    await a.chatwoot({ event: "conversation_status_changed", id: 900, status: "resolved" });
    await a.chatwoot({ event: "conversation_status_changed", id: 900, status: "open" });
    expect(a.calls.map((c) => c.url)).toEqual([
      "https://wakeel.example.test/v1/bridge/conversations/cw-2-900/handoff/release",
      "https://wakeel.example.test/v1/bridge/conversations/cw-2-900/end",
    ]);
  });

  test("greet-first pairs send conversation_started once per conversation", async () => {
    const a = await start({ pair: { greetFirst: true } });
    const opened = {
      event: "conversation_created",
      conversation: { id: 900, status: "pending", meta: { sender: contact } },
    };
    await a.chatwoot(opened);
    await a.chatwoot(opened);
    expect(a.calls).toHaveLength(1);
    expect(a.calls[0]?.body).toMatchObject({ name: "conversation_started", userId: "cw-2-contact-77" });
  });

  test("when the platform keeps failing, Chatwoot gets a note and the conversation opens for a human", async () => {
    const a = await start({ status: (c) => (c.url.includes("/v1/bridge/") ? 503 : 200) });
    await a.chatwoot(incoming());
    const bridgeCalls = a.calls.filter((c) => c.url.includes("/v1/bridge/"));
    expect(bridgeCalls).toHaveLength(5);
    expect(a.calls.slice(5).map((c) => [c.url, c.body])).toEqual([
      [
        "https://chat.example.test/api/v1/accounts/2/conversations/900/messages",
        {
          content: "The assistant is unavailable. Please take over this conversation.",
          message_type: "outgoing",
          private: true,
        },
      ],
      ["https://chat.example.test/api/v1/accounts/2/conversations/900/toggle_status", { status: "open" }],
    ]);
    expect(a.logs.join("\n")).not.toContain("canary");
  });
});

describe("platform → Chatwoot", () => {
  const cwUrl = (path: string) => `https://chat.example.test/api/v1/accounts/2/conversations/900${path}`;

  test("text round-trips Arabic, an English product code and an emoji unchanged", async () => {
    const a = await start();
    const text = "دورة التكييف (HVAC) متاحة أونلاين ✅";
    expect(await a.bridge(botMessage({ type: "text", text, format: "markdown" }))).toBe(204);
    expect(a.calls).toEqual([
      {
        method: "POST",
        url: cwUrl("/messages"),
        headers: { api_access_token: "cw-token-canary" },
        body: { message_type: "outgoing", content: text },
      },
    ]);
  });

  test("choices become input_select on a widget and a numbered list elsewhere; ٢ then picks option 2", async () => {
    const a = await start();
    const choice = {
      type: "choice",
      text: "أو اختر مباشرة:",
      options: [
        { label: "أبحث عن دورة تناسبني", value: "find_course" },
        { label: "مجالات التدريب", value: "fields" },
      ],
    };
    await a.bridge(botMessage(choice));
    expect(a.calls[0]?.body).toEqual({
      message_type: "outgoing",
      content: "أو اختر مباشرة:",
      content_type: "input_select",
      content_attributes: {
        items: [
          { title: "أبحث عن دورة تناسبني", value: "find_course" },
          { title: "مجالات التدريب", value: "fields" },
        ],
      },
    });

    const b = await start();
    await b.chatwoot(incoming({ conversation: { id: 900, status: "pending", channel: "Channel::Whatsapp" } }));
    b.calls.length = 0;
    await b.bridge(botMessage(choice), (raw) => signBody(raw, SECRET, NOW / 1000));
    expect(b.calls[0]?.body).toEqual({
      message_type: "outgoing",
      content: "أو اختر مباشرة:\n\n1. أبحث عن دورة تناسبني\n2. مجالات التدريب",
    });
    b.calls.length = 0;
    await b.chatwoot(
      incoming({ id: 502, content: "٢", conversation: { id: 900, status: "pending", channel: "Channel::Whatsapp" } }),
    );
    expect(b.calls[0]?.body).toMatchObject({ message: { type: "postback", value: "fields", label: "٢" } });
  });

  test("handoff: private note with reason and summary, open, assign the team, label", async () => {
    const a = await start();
    await a.bridge(
      envelope("handoff.requested", { reason: "sales", summary: "العميل يريد التسجيل في دورة HVAC.", variables: {} }),
    );
    expect(a.calls.map((c) => [c.url, c.body])).toEqual([
      [
        cwUrl("/messages"),
        {
          content: "Handoff reason: sales\n\nالعميل يريد التسجيل في دورة HVAC.",
          message_type: "outgoing",
          private: true,
        },
      ],
      [cwUrl("/toggle_status"), { status: "open" }],
      [cwUrl("/assignments"), { team_id: 9 }],
      [cwUrl("/labels"), { labels: ["bot-handoff"] }],
    ]);
  });

  test("typing is best effort and turn.completed does nothing", async () => {
    const a = await start({ status: () => 500 });
    expect(await a.bridge(envelope("typing", { state: "on" }, "evt_01m7gxdey4gehxa8njzgyc22e1"))).toBe(204);
    expect(
      await a.bridge(
        envelope(
          "turn.completed",
          { status: "waiting", messageCount: 1, durationMs: 900 },
          "evt_01m7gxdey4gehxa8njzgyc22e2",
        ),
      ),
    ).toBe(204);
    expect(a.calls).toHaveLength(1);
  });

  test("a Chatwoot refusal answers 502 so the platform retries, and the retry is processed", async () => {
    let fail = true;
    const a = await start({ status: () => (fail ? 500 : 200) });
    const event = botMessage({ type: "text", text: "مرحبا", format: "markdown" });
    expect(await a.bridge(event)).toBe(502);
    fail = false;
    expect(await a.bridge(event)).toBe(204);
    expect(a.calls).toHaveLength(2);
  });

  test("events for conversations that are not this Chatwoot account's are acknowledged and skipped", async () => {
    const a = await start();
    const event = {
      ...botMessage({ type: "text", text: "hi", format: "markdown" }),
      conversation: { id: "conv_x", externalId: "web-1" },
    };
    expect(await a.bridge(event)).toBe(204);
    expect(a.calls).toEqual([]);
  });
});

describe("webhook security", () => {
  const event = () => botMessage({ type: "text", text: "مرحبا", format: "markdown" });

  test("a tampered signature, a wrong secret and an old timestamp are rejected", async () => {
    const a = await start();
    expect(await a.bridge(event(), (raw) => signBody(raw, SECRET, NOW / 1000).replace(/.$/, "0"))).toBe(401);
    expect(await a.bridge(event(), (raw) => signBody(raw, "whsec_other", NOW / 1000))).toBe(401);
    expect(await a.bridge(event(), (raw) => signBody(raw, SECRET, NOW / 1000 - 301))).toBe(401);
    expect(await a.bridge(event(), () => "")).toBe(401);
    expect(a.calls).toEqual([]);
  });

  test("a replayed event id is acknowledged without a second Chatwoot call", async () => {
    const a = await start();
    expect(await a.bridge(event())).toBe(204);
    expect(await a.bridge(event())).toBe(200);
    expect(a.calls).toHaveLength(1);
  });

  test("a signature from the previous secret still verifies during a rotation", async () => {
    const a = await start({ pair: { bridgeSigningSecrets: ["whsec_new", SECRET] } });
    expect(await a.bridge(event())).toBe(204);
  });

  test("unknown pair slugs and methods are refused; health answers", async () => {
    const a = await start();
    expect(
      (await fetch(`${a.base}/chatwoot/not-a-real-pair-slug/webhook`, { method: "POST", body: "{}" })).status,
    ).toBe(404);
    expect((await fetch(`${a.base}/bridge/${PAIR_ID}/webhook`)).status).toBe(405);
    expect((await fetch(`${a.base}/healthz`)).status).toBe(200);
  });
});
