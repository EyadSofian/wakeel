import { API_VERSION, type BridgeEvent, type EmulatorStateResponse, type Problem, type Span } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { ApiError } from "../api/client";
import { createEmulatorStore, type EmulatorTransport } from "./controller";

const BASE = "/v1/workspaces/ws_01m7a256m0a13warwhczsjhx9g/bots/bot_01m7a256m0a13warwhczsjhx9b/emulator";

const event = (n: number, type: "message.created" | "turn.completed"): BridgeEvent => {
  const envelope = {
    id: `evt_01m7a256m0a13warwhczsjh${String(n).padStart(3, "0")}`,
    apiVersion: API_VERSION,
    createdAt: "2026-11-14T10:00:00.000Z",
    connectionId: "conn_01m7a256m0a13warwhczsjhx9c",
    botId: "bot_01m7a256m0a13warwhczsjhx9b",
    conversation: { id: "conv_01m7a256m0a13warwhczsjhx9v", externalId: "emu-1" },
    user: { id: "eu_01m7a256m0a13warwhczsjhx9u", externalId: "test-user" },
    turnId: "turn_01m7a256m0a13warwhczsjhx9t",
    seq: n,
    ephemeral: false,
  };
  return type === "turn.completed"
    ? { ...envelope, type, data: { status: "waiting", messageCount: 1, durationMs: 40 } }
    : {
        ...envelope,
        type,
        data: {
          message: {
            id: `msg_01m7a256m0a13warwhczsjh${String(n).padStart(3, "0")}`,
            conversationId: "conv_01m7a256m0a13warwhczsjhx9v",
            seq: n,
            direction: "out",
            payload: { type: "text", text: `رد ${n}`, format: "markdown" },
            citations: [],
            createdAt: "2026-11-14T10:00:00.000Z",
          },
        },
      };
};

const state = (value: string): EmulatorStateResponse => ({
  conversationId: "conv_01m7a256m0a13warwhczsjhx9v",
  status: "waiting_input",
  variables: [{ id: "var_AAAAAAAAAA", name: "city", scope: "conversation", type: "string", value, sensitive: false }],
  attributes: {},
  stateBytes: 120,
  limitBytes: 262_144,
});

const traceSpan = (seq: number, extra: Record<string, unknown> = {}): Span =>
  ({
    id: `span_01m7a256m0a13warwhczsj${String(seq).padStart(4, "0")}`,
    workspaceId: "ws_01m7a256m0a13warwhczsjhx9g",
    botId: "bot_01m7a256m0a13warwhczsjhx9b",
    conversationId: "conv_01m7a256m0a13warwhczsjhx9v",
    turnId: "turn_01m7a256m0a13warwhczsjhx9t",
    seq,
    name: seq === 0 ? "Turn" : "Greet",
    status: "ok",
    startedAt: "2026-11-14T10:00:00.000Z",
    durationMs: 0,
    location: seq === 0 ? {} : { workflowId: "wf_MAINAAAAAA", nodeId: "node_GREETAAAAA" },
    kind: seq === 0 ? "turn" : "node",
    attrs: seq === 0 ? { trigger: "message", mode: "emulator" } : { nodeType: "standard" },
    ...extra,
  }) as Span;

function fake(
  script: {
    events?: BridgeEvent[];
    fail?: Problem;
    state?: EmulatorStateResponse[];
    spans?: Span[];
    trace?: Span[];
  } = {},
) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const states = [...(script.state ?? [state("القاهرة")])];
  const transport: EmulatorTransport = {
    async stream(path, body, onEvent, onSpan) {
      calls.push({ method: "STREAM", path, body });
      if (script.fail) throw new ApiError(script.fail);
      for (const sp of script.spans ?? []) onSpan(sp);
      for (const e of script.events ?? [event(2, "message.created"), event(3, "turn.completed")]) onEvent(e);
    },
    async put(path, body) {
      calls.push({ method: "PUT", path, body });
      return {};
    },
    async trace(turnId) {
      calls.push({ method: "TRACE", path: turnId });
      return { turnId, conversationId: "conv_01m7a256m0a13warwhczsjhx9v", spans: script.trace ?? [] };
    },
    async get(path) {
      calls.push({ method: "GET", path });
      return states.length > 1 ? (states.shift() as EmulatorStateResponse) : (states[0] as EmulatorStateResponse);
    },
  };
  let n = 0;
  const store = createEmulatorStore({ base: BASE, transport, newConversationId: () => `emu-${++n}` });
  return { store, calls };
}

describe("the emulator controller", () => {
  test("the first message names the test user; later ones do not; both stream into the transcript", async () => {
    const { store, calls } = fake();
    await store.getState().send("مرحبا");
    await store.getState().send("تاني");
    const streams = calls.filter((c) => c.method === "STREAM");
    expect(streams[0]).toEqual({
      method: "STREAM",
      path: `${BASE}/conversations/emu-1/messages`,
      body: {
        userId: "test-user",
        user: { name: "Test user", attributes: {} },
        message: { type: "text", text: "مرحبا" },
      },
    });
    expect(streams[1]?.body).toEqual({ userId: "test-user", message: { type: "text", text: "تاني" } });
    const t = store.getState().transcript;
    expect(t.running).toBe(false);
    expect(t.items.filter((i) => i.kind === "message").map((i) => i.direction)).toEqual(["in", "out", "in"]);
  });

  test("after each turn the variables are read again and changes are marked", async () => {
    const { store } = fake({ state: [state("القاهرة"), state("جدة")] });
    await store.getState().send("مرحبا");
    expect(store.getState().changed).toEqual(new Set());
    await store.getState().send("أنا في جدة");
    expect(store.getState().variables?.variables[0]?.value).toBe("جدة");
    expect(store.getState().changed).toEqual(new Set(["var_AAAAAAAAAA"]));
  });

  test("a button press sends a postback with its label", async () => {
    const { store, calls } = fake();
    await store.getState().postback("track", "تتبع الطلب");
    expect(calls[0]?.body).toMatchObject({ message: { type: "postback", value: "track", label: "تتبع الطلب" } });
    expect(store.getState().transcript.items[0]).toMatchObject({ direction: "in", payload: { label: "تتبع الطلب" } });
  });

  test("reset starts a new conversation and keeps the test user", async () => {
    const { store, calls } = fake();
    await store.getState().saveUser({ name: "منى", locale: "ar-EG", attributes: { plan: "pro" } });
    await store.getState().send("مرحبا");
    store.getState().reset();
    expect(store.getState().transcript.items).toEqual([]);
    expect(store.getState().variables).toBeUndefined();
    await store.getState().send("من الأول");
    const streams = calls.filter((c) => c.method === "STREAM");
    expect(streams.map((c) => c.path)).toEqual([
      `${BASE}/conversations/emu-1/messages`,
      `${BASE}/conversations/emu-2/messages`,
    ]);
    expect(streams[1]?.body).toMatchObject({ user: { name: "منى", locale: "ar-EG", attributes: { plan: "pro" } } });
  });

  test("saving the test user updates it on the API when a conversation exists", async () => {
    const { store, calls } = fake();
    await store.getState().saveUser({ name: "منى", attributes: {} });
    expect(calls).toEqual([]);
    await store.getState().send("مرحبا");
    await store.getState().saveUser({ name: "منى", attributes: { plan: "pro" } });
    expect(calls.at(-2)).toEqual({
      method: "PUT",
      path: `${BASE}/users/test-user`,
      body: { name: "منى", attributes: { plan: "pro" } },
    });
  });

  test("Run from here opens the emulator on a new conversation that starts at the node", async () => {
    const { store, calls } = fake();
    await store.getState().send("مرحبا");
    await store.getState().runFrom("wf_AAAAAAAAAA", "node_AAAAAAAAAA", "Ask for the order");
    expect(store.getState().open).toBe(true);
    const last = calls.filter((c) => c.method === "STREAM").at(-1);
    expect(last).toEqual({
      method: "STREAM",
      path: `${BASE}/conversations/emu-2/run-from`,
      body: {
        userId: "test-user",
        user: { name: "Test user", attributes: {} },
        workflowId: "wf_AAAAAAAAAA",
        nodeId: "node_AAAAAAAAAA",
      },
    });
    expect(store.getState().startedAt).toBe("Ask for the order");
  });

  test("a failed request shows its title and fix in the transcript and ends the turn", async () => {
    const { store } = fake({
      fail: {
        type: "about:blank",
        title: "Your role does not allow this",
        status: 403,
        code: "forbidden",
        fix: "Ask a workspace admin for access.",
        requestId: "req-1",
      },
    });
    await store.getState().send("مرحبا");
    const t = store.getState().transcript;
    expect(t.running).toBe(false);
    expect(t.items.at(-1)).toMatchObject({
      kind: "problem",
      title: "Your role does not allow this",
      fix: "Ask a workspace admin for access.",
    });
  });

  test("a stream that ends before turn.completed says so instead of spinning", async () => {
    const { store } = fake({ events: [event(2, "message.created")] });
    await store.getState().send("مرحبا");
    const t = store.getState().transcript;
    expect(t.running).toBe(false);
    expect(t.items.at(-1)).toMatchObject({ kind: "problem", title: "The turn is still running" });
  });
});

describe("the trace (task 4.7)", () => {
  const TURN = "turn_01m7a256m0a13warwhczsjhx9t";

  test("spans stream into the turn's trace; a span sent again replaces its copy; the run overlay follows the turn", async () => {
    const { store } = fake({ spans: [traceSpan(0), traceSpan(1), traceSpan(0, { durationMs: 40 })] });
    await store.getState().send("مرحبا");
    const s = store.getState();
    expect(s.traces[TURN]?.map((x) => [x.seq, x.durationMs])).toEqual([
      [0, 40],
      [1, 0],
    ]);
    expect(s.traceTurn).toBe(TURN);
    expect(s.overlayTurn).toBe(TURN);
    store.getState().clearOverlay();
    expect(store.getState().overlayTurn).toBeUndefined();
  });

  test("the turn footer knows its turn, and opening it shows that trace with the area expanded", async () => {
    const { store } = fake({ spans: [traceSpan(0)] });
    await store.getState().send("مرحبا");
    const footer = store.getState().transcript.items.find((i) => i.kind === "footer");
    expect(footer && "turnId" in footer && footer.turnId).toBe(TURN);
    await store.getState().openTrace(TURN);
    expect(store.getState()).toMatchObject({ traceTurn: TURN, area: { open: true, tab: "trace" } });
  });

  test("a turn whose spans were not streamed is fetched once from the trace endpoint", async () => {
    const { store, calls } = fake({ trace: [traceSpan(0)] });
    await store.getState().openTrace("turn_01m7a256m0a13warwhczsjhx9z");
    await store.getState().openTrace("turn_01m7a256m0a13warwhczsjhx9z");
    expect(calls.filter((c) => c.method === "TRACE")).toHaveLength(1);
    expect(store.getState().traces["turn_01m7a256m0a13warwhczsjhx9z"]).toHaveLength(1);
  });

  test("selecting a step remembers it; reset clears traces, overlay and selection", async () => {
    const { store } = fake({ spans: [traceSpan(0), traceSpan(1)] });
    await store.getState().send("مرحبا");
    store.getState().selectStep(traceSpan(1).id);
    expect(store.getState().selectedStep).toBe(traceSpan(1).id);
    store.getState().reset();
    expect(store.getState()).toMatchObject({
      traces: {},
      traceTurn: undefined,
      overlayTurn: undefined,
      selectedStep: undefined,
    });
  });
});
