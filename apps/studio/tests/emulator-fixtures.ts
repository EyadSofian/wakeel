import {
  API_VERSION,
  type BotMessagePayload,
  type BridgeEvent,
  type EmulatorStateResponse,
  type Span,
} from "@wakeel/contracts";
import { SCREENSHOT_FIXTURES } from "@wakeel/testing/fixtures/rtl";

/**
 * Emulator turns for the screenshot review (task 4.6): each scenario is the SSE body the mock API
 * answers a message with, so the transcript, banners and Variables tab are deterministic.
 */
export type EmulatorScenario = "conversation" | "bubbles" | "error" | "rtl" | "running";

const CONV = "conv_01m7a256m0a13warwhczsjhx9v";
/** One turn id per turn of a scenario, so each turn has its own trace. */
const TURNS = ["turn_01m7a256m0a13warwhczsjhx9t", "turn_01m7a256m0a13warwhczsjhx9s", "turn_01m7a256m0a13warwhczsjhx9r"];
let TURN = TURNS[0] as string;
const T = "2026-11-14T10:00:00.000Z";
/** Served by the mock API (mock-api.ts) so the image bubble has something to show offline. */
export const MOCK_IMAGE_URL = "http://127.0.0.1:5173/v1/__mock/product.svg";

let counter = 0;
const envelope = (ephemeral = false) => {
  counter += 1;
  const n = String(counter).padStart(4, "0");
  return {
    id: `evt_01m7a256m0a13warwhczsj${n}`,
    apiVersion: API_VERSION,
    createdAt: T,
    connectionId: "conn_01m7a256m0a13warwhczsjhx9c",
    botId: "bot_01m7a256m0a13warwhczsjhx9b",
    conversation: { id: CONV, externalId: "emu-shots" },
    user: { id: "eu_01m7a256m0a13warwhczsjhx9e", externalId: "test-user" },
    turnId: TURN,
    ephemeral,
    ...(ephemeral ? {} : { seq: counter }),
  };
};

const message = (payload: BotMessagePayload): BridgeEvent => {
  const e = envelope();
  return {
    ...e,
    type: "message.created",
    data: {
      message: {
        id: `msg_01m7a256m0a13warwhczsj${String(counter).padStart(4, "0")}`,
        conversationId: CONV,
        seq: counter,
        direction: "out",
        payload,
        citations: [],
        turnId: TURN,
        createdAt: T,
      },
    },
  };
};

const done = (status: "waiting" | "completed" | "failed" = "waiting", durationMs = 1820): BridgeEvent => ({
  ...envelope(),
  type: "turn.completed",
  data: { status, messageCount: 1, durationMs },
});

const text = (t: string): BotMessagePayload => ({ type: "text", text: t, format: "markdown" });

/** The bot's answer to the `n`-th message the builder sends in a scenario (0-based). */
export function turnEvents(scenario: EmulatorScenario, n: number, sent: string): BridgeEvent[] {
  TURN = TURNS[n % TURNS.length] as string;
  switch (scenario) {
    case "conversation":
      return n === 0
        ? [
            message(text("أكيد. ممكن **رقم الطلب**؟ تقدر تلاقيه في رسالة التأكيد.")),
            message({
              type: "choice",
              text: "أو اختار من دول:",
              options: [
                { label: "تتبع الطلب", value: "track" },
                { label: "مرتجع", value: "return" },
                { label: "حاجة تانية", value: "other" },
              ],
            }),
            done(),
          ]
        : [message(text(SCREENSHOT_FIXTURES[1]?.text ?? "")), done("completed", 940)];
    case "bubbles":
      return [
        message(
          text(
            "Here is what we found:\n\n- **Order** `ORD-2026-45123`\n- Ships from Cairo\n\nTrack it at https://track.example.com/orders/45123",
          ),
        ),
        message({
          type: "card",
          title: "سماعة لاسلكية",
          subtitle: "1,250 EGP · in stock",
          imageUrl: MOCK_IMAGE_URL,
          actions: [
            { type: "postback", label: "Buy", value: "buy" },
            { type: "url", label: "Details", value: "https://shop.example.com/p/1" },
          ],
        }),
        message({ type: "image", url: MOCK_IMAGE_URL, alt: "Product photo", caption: "الصورة من المخزن" }),
        message({
          type: "file",
          url: "https://shop.example.com/invoice.pdf",
          name: "invoice-45123.pdf",
          mime: "application/pdf",
          sizeBytes: 182_400,
        }),
        message({
          type: "location",
          latitude: 30.0444,
          longitude: 31.2357,
          title: "فرع وسط البلد",
          address: "شارع طلعت حرب، القاهرة",
        }),
        message({
          type: "dropdown",
          text: "Pick a delivery slot",
          placeholder: "Choose a time",
          options: [
            { label: "Today, 6–9 pm", value: "today" },
            { label: "Tomorrow morning", value: "tomorrow" },
          ],
        }),
        message({ type: "custom", name: "order_summary", data: { orderId: "ORD-2026-45123", items: 2 } }),
        done("waiting", 2410),
      ];
    case "error":
      return [
        {
          ...envelope(),
          type: "error",
          data: {
            code: "code_timeout",
            message: "Run code in “Check stock” took longer than 10000 ms",
            retryable: true,
          },
        },
        message(text("حصلت مشكلة عندنا، جرب تاني بعد شوية.")),
        done("failed", 10_040),
      ];
    case "rtl":
      return [message(text(sent)), done("completed", 610)];
    case "running":
      return [];
  }
}

/** The SSE body of a turn, as the API streams it: its spans (ADR-026), then its events. */
export const sseBody = (events: readonly BridgeEvent[], spans: readonly Span[] = []) =>
  [
    ...spans.map((x) => `event: trace.span\ndata: ${JSON.stringify(x)}\n\n`),
    ...events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
  ].join("");

/** Ids of the typical canvas (canvas-fixtures.ts): its Greeting node and cards, its FAQ node. */
const C = (prefix: string, n: number) => `${prefix}_${String(n).padStart(10, "0")}`;
const WF = C("wf", 1);

/**
 * The trace of the `n`-th turn of the conversation scenario, on the typical canvas: turn 1 says
 * hello and asks; turn 2 takes the answer, branches to Shipping FAQ and answers there.
 */
export function turnSpans(scenario: EmulatorScenario, n: number): Span[] {
  if (scenario !== "conversation") return [];
  const turnId = TURNS[n % TURNS.length] as string;
  let seq = 0;
  const id = () => `span_01m7a256m0a13warwhczs${String(n * 100 + seq).padStart(5, "0")}`;
  const base = (extra: Record<string, unknown>) => {
    const out = {
      id: id(),
      workspaceId: "ws_01m7a256m0a13warwhczsjhx9g",
      botId: "bot_01m7a256m0a13warwhczsjhx9b",
      conversationId: CONV,
      turnId,
      seq,
      status: "ok",
      startedAt: T,
      location: {},
      ...extra,
    };
    seq += 1;
    return out;
  };
  const turn = base({
    name: "Turn",
    durationMs: n === 0 ? 1820 : 940,
    kind: "turn",
    attrs: {
      trigger: "message",
      mode: "emulator",
      outcome: n === 0 ? "waiting" : "completed",
      stepCount: n === 0 ? 2 : 3,
    },
  });
  const at = (node: number, card?: number) => ({
    workflowId: WF,
    nodeId: C("node", node),
    ...(card ? { cardId: C("card", card) } : {}),
  });
  const greet = base({
    parentId: turn.id,
    name: "Greeting",
    durationMs: n === 0 ? 1790 : 210,
    kind: "node",
    location: at(2),
    attrs: { nodeType: "standard", leftBy: n === 0 ? "wait" : "goto" },
  });
  const spans: unknown[] = [turn, greet];
  if (n === 0) {
    spans.push(
      base({
        parentId: greet.id,
        name: "say",
        durationMs: 30,
        kind: "card",
        location: at(2, 1),
        attrs: { cardType: "say", outcome: "next" },
      }),
    );
    spans.push(
      base({
        parentId: greet.id,
        name: "capture",
        durationMs: 1760,
        kind: "card",
        location: at(2, 2),
        attrs: { cardType: "capture", outcome: "wait" },
      }),
    );
  } else {
    spans.push(
      base({
        parentId: greet.id,
        name: "capture",
        durationMs: 20,
        kind: "card",
        location: at(2, 2),
        attrs: {
          cardType: "capture",
          outcome: "next",
          writes: { [C("var", 2)]: { before: null, after: "shipping 5678" } },
        },
      }),
    );
    spans.push(
      base({
        parentId: greet.id,
        name: "branch",
        durationMs: 190,
        kind: "card",
        location: at(2, 3),
        attrs: { cardType: "branch", outcome: "goto" },
      }),
    );
    const faq = base({
      parentId: turn.id,
      name: "Shipping FAQ",
      durationMs: 700,
      kind: "node",
      location: at(4),
      attrs: { nodeType: "standard", leftBy: "next" },
    });
    spans.push(faq);
    spans.push(
      base({
        parentId: faq.id,
        name: "say",
        durationMs: 700,
        kind: "card",
        location: at(4, 4),
        attrs: { cardType: "say", outcome: "next" },
      }),
    );
  }
  return spans as Span[];
}

/** The Variables tab after the `n`-th turn: the second turn changes city and adds an order id. */
export function emulatorState(n: number): EmulatorStateResponse {
  return {
    conversationId: CONV,
    status: "waiting_input",
    variables: [
      {
        id: "var_city000000",
        name: "city",
        scope: "conversation",
        type: "string",
        value: n === 0 ? "القاهرة" : "الجيزة",
        sensitive: false,
      },
      {
        id: "var_order00000",
        name: "orderId",
        scope: "conversation",
        type: "string",
        value: n === 0 ? null : "ORD-2026-45123",
        sensitive: false,
      },
      { id: "var_token00000", name: "apiToken", scope: "conversation", type: "string", value: null, sensitive: true },
      { id: "var_visits0000", name: "visits", scope: "user", type: "number", value: 3, sensitive: false },
      {
        id: "var_greeting00",
        name: "greeting",
        scope: "bot",
        type: "string",
        value: "أهلاً بيك في متجر النور",
        sensitive: false,
      },
    ],
    attributes: { name: "Test user", plan: "pro", odooPartnerId: 4411 },
    stateBytes: n === 0 ? 1_240 : 1_910,
    limitBytes: 262_144,
  };
}

/** What the builder types in each scenario, in order. */
export const SENT: Record<EmulatorScenario, string[]> = {
  conversation: ["عايز أعرف حالة طلبي"],
  bubbles: ["Show me everything"],
  error: ["فين طلبي؟"],
  rtl: SCREENSHOT_FIXTURES.filter((f) =>
    ["pure_arabic", "english_arabic_name", "arabic_url", "emoji"].includes(f.id),
  ).map((f) => f.text),
  running: ["مرحبا"],
};
