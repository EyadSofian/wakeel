import { API_VERSION, type BridgeEvent, type EmulatorStateResponse } from "@wakeel/contracts";
import { RTL_FIXTURES } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { applyEvent, changedVariables, emptyTranscript, startTurn, type Transcript, userMessage } from "./model";
import { SseParser } from "./sse";

const envelope = (seq: number | undefined, turnId = "turn_01m7a256m0a13warwhczsjhx9t") => ({
  id: `evt_01m7a256m0a13warwhczsjhx${String(seq ?? 0).padStart(2, "0")}`,
  apiVersion: API_VERSION,
  createdAt: "2026-11-14T10:00:00.000Z",
  connectionId: "conn_01m7a256m0a13warwhczsjhx9c",
  botId: "bot_01m7a256m0a13warwhczsjhx9b",
  conversation: { id: "conv_01m7a256m0a13warwhczsjhx9v", externalId: "emu-1" },
  user: { id: "eu_01m7a256m0a13warwhczsjhx9u", externalId: "test-user" },
  turnId,
  ephemeral: seq === undefined,
  ...(seq === undefined ? {} : { seq }),
});

const botText = (seq: number, text: string): BridgeEvent => ({
  ...envelope(seq),
  type: "message.created",
  data: {
    message: {
      id: `msg_01m7a256m0a13warwhczsjh${String(seq).padStart(3, "0")}`,
      conversationId: "conv_01m7a256m0a13warwhczsjhx9v",
      seq,
      direction: "out",
      payload: { type: "text", text, format: "markdown" },
      citations: [],
      turnId: "turn_01m7a256m0a13warwhczsjhx9t",
      createdAt: "2026-11-14T10:00:00.000Z",
    },
  },
});

const completed = (status: "completed" | "waiting" | "failed" = "waiting"): BridgeEvent => ({
  ...envelope(9),
  type: "turn.completed",
  data: { status, messageCount: 1, durationMs: 1820 },
});

const run = (events: BridgeEvent[], from: Transcript = startTurn(userMessage(emptyTranscript(), "مرحبا"))) =>
  events.reduce(applyEvent, from);

describe("SseParser", () => {
  test("frames split across chunks, several frames in one chunk, and comments", () => {
    const p = new SseParser();
    expect(p.feed('event: typing\ndata: {"a":')).toEqual([]);
    expect(p.feed('1}\n\n: keep-alive\n\nevent: turn.completed\ndata: {"b":2}\n\n')).toEqual([
      { event: "typing", data: '{"a":1}' },
      { event: "turn.completed", data: '{"b":2}' },
    ]);
  });

  test("CRLF line ends and multi-line data", () => {
    const p = new SseParser();
    expect(p.feed("event: x\r\ndata: one\r\ndata: two\r\n\r\n")).toEqual([{ event: "x", data: "one\ntwo" }]);
  });
});

describe("the emulator transcript", () => {
  test("a user message is shown at once and the turn runs until turn.completed", () => {
    const t = startTurn(userMessage(emptyTranscript(), "عايز أعرف حالة طلبي"));
    expect(t.items.map((i) => i.kind)).toEqual(["message"]);
    expect(t.running).toBe(true);
    const done = run([botText(2, "أكيد. ممكن رقم الطلب؟"), completed()], t);
    expect(done.running).toBe(false);
    expect(done.items.map((i) => i.kind)).toEqual(["message", "message", "footer"]);
    expect(done.items[2]).toMatchObject({ kind: "footer", durationMs: 1820, status: "waiting" });
  });

  test("typing shows only while nothing has arrived; ephemeral typing off hides it", () => {
    const on: BridgeEvent = { ...envelope(undefined), type: "typing", data: { state: "on" } };
    // Ephemeral events have ids of their own too.
    const off: BridgeEvent = {
      ...envelope(undefined),
      id: "evt_01m7a256m0a13warwhczsjhxof",
      type: "typing",
      data: { state: "off" },
    };
    expect(run([on]).typing).toBe(true);
    expect(run([on, botText(2, "أهلاً")]).typing).toBe(false);
    expect(run([on, off]).typing).toBe(false);
  });

  test("the same event twice is applied once (SSE and a retry may both carry it)", () => {
    const e = botText(2, "مرة واحدة");
    expect(run([e, e]).items.filter((i) => i.kind === "message")).toHaveLength(2);
  });

  test("an error event becomes a banner with the code's title and fix", () => {
    const err: BridgeEvent = {
      ...envelope(3),
      type: "error",
      data: { code: "code_timeout", message: "Run code took longer than 10 s", retryable: true },
    };
    const banner = run([err, completed("failed")]).items.find((i) => i.kind === "error");
    expect(banner).toMatchObject({ kind: "error", code: "code_timeout" });
    expect(banner && "title" in banner && banner.title.length).toBeGreaterThan(0);
    expect(banner && "fix" in banner && banner.fix.length).toBeGreaterThan(0);
  });

  test("an unknown error code still shows its message", () => {
    const err: BridgeEvent = {
      ...envelope(3),
      type: "error",
      data: { code: "made_up_code", message: "Something specific", retryable: false },
    };
    expect(run([err]).items.find((i) => i.kind === "error")).toMatchObject({ title: "Something specific" });
  });

  test("handoff and the end of the conversation", () => {
    const handoff: BridgeEvent = {
      ...envelope(3),
      type: "handoff.requested",
      data: { reason: "طلب استرجاع", summary: "", variables: {} },
    };
    const ended: BridgeEvent = { ...envelope(4), type: "conversation.ended", data: { reason: "completed" } };
    const t = run([handoff, ended]);
    expect(t.items.map((i) => i.kind)).toContain("handoff");
    expect(t.items.map((i) => i.kind)).toContain("ended");
    expect(t.status).toBe("ended");
  });

  test("only the newest bot message's buttons are live", () => {
    const choice = (seq: number): BridgeEvent => {
      const e = botText(seq, "اختار") as Extract<BridgeEvent, { type: "message.created" }>;
      return {
        ...e,
        data: {
          message: {
            ...e.data.message,
            payload: { type: "choice", text: "اختار", options: [{ label: "أ", value: "a" }] },
          },
        },
      };
    };
    const t = run([choice(2), completed(), choice(4)]);
    const live = t.items.filter((i) => i.kind === "message" && i.live).map((i) => i.key);
    expect(live).toEqual([t.items.filter((i) => i.kind === "message").at(-1)?.key]);
  });

  test.each(RTL_FIXTURES.map((f) => [f.id, f.text] as const))("RTL fixture %s is kept as sent", (_id, text) => {
    const t = run([botText(2, text)], startTurn(userMessage(emptyTranscript(), text)));
    const texts = t.items.flatMap((i) => (i.kind === "message" && "text" in i.payload ? [i.payload.text] : []));
    expect(texts).toEqual([text, text]);
  });
});

describe("changedVariables", () => {
  const snapshot = (values: Record<string, unknown>): EmulatorStateResponse => ({
    conversationId: "conv_01m7a256m0a13warwhczsjhx9v",
    status: "idle",
    variables: Object.entries(values).map(([id, value]) => ({
      id: id as `var_${string}`,
      name: id,
      scope: "conversation",
      type: "string",
      value: value as never,
      sensitive: false,
    })),
    attributes: {},
    stateBytes: 10,
    limitBytes: 262_144,
  });

  test("ids whose value changed or that are new since the last turn", () => {
    expect(
      changedVariables(
        snapshot({ var_a: "1", var_b: { x: 1 } }),
        snapshot({ var_a: "1", var_b: { x: 2 }, var_c: "new" }),
      ),
    ).toEqual(new Set(["var_b", "var_c"]));
    expect(changedVariables(undefined, snapshot({ var_a: "1" }))).toEqual(new Set());
  });
});
