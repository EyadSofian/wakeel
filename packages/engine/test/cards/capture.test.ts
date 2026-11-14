import type { EventScope, Frame, WaitSpec } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  cardId,
  definition,
  edge,
  event,
  failures,
  harness,
  message,
  nodeId,
  run,
  standard,
  state,
  texts,
  varId,
  workflow,
} from "../turn/harness";

/** The Capture card (card.ts `CaptureCard`, build plan 4.3) run by the engine's own executor. */

const NOW = "2026-11-13T09:00:00.000Z";

interface CaptureOptions {
  kind?: string;
  type?: string;
  prompt?: unknown;
  validate?: unknown;
  maxRetries?: number;
  retryMessage?: string;
  skipIfFilled?: boolean;
  routeByOption?: boolean;
  /** Port keys of the card to connect to their own nodes, each with one Log card. */
  connect?: string[];
}

function captureBot(o: CaptureOptions = {}) {
  const ask = cardId();
  const after = cardId();
  const into = varId();
  const start = nodeId();
  const node = nodeId();
  const targets: Record<string, string> = {};
  const extraNodes: unknown[] = [];
  const extraEdges: unknown[] = [];
  for (const key of o.connect ?? []) {
    const id = nodeId();
    const card = cardId();
    targets[key] = card;
    extraNodes.push(standard(id, [{ id: card, type: "log", message: key }]));
    extraEdges.push(edge(node, `card:${ask}:${key}`, id));
  }
  const card = {
    id: ask,
    type: "capture",
    prompt: o.prompt ?? { type: "text", text: "رقم الطلب كام؟" },
    kind: o.kind ?? "number",
    into,
    ...(o.validate ? { validate: o.validate } : {}),
    ...(o.maxRetries !== undefined ? { maxRetries: o.maxRetries } : {}),
    ...(o.retryMessage ? { retryMessage: o.retryMessage } : {}),
    ...(o.skipIfFilled ? { skipIfFilled: true } : {}),
    ...(o.routeByOption ? { routeByOption: true } : {}),
  };
  const main = workflow({
    nodes: [
      { id: start, type: "start", name: "Start" },
      standard(node, [card, { id: after, type: "log", message: "after" }]),
      ...extraNodes,
    ],
    edges: [edge(start, "next", node), ...extraEdges],
  });
  const def = definition({
    workflows: [main],
    variables: [{ id: into, name: "answer", scope: "conversation", type: o.type ?? "number" }],
  });
  const frame: Frame = { workflowId: main.id, nodeId: node, cardIndex: 0, vars: {}, inputs: {} };
  const waiting = (attempts = 0) => {
    const wait: WaitSpec = { kind: "capture", nodeId: node, cardId: ask, attempts, since: NOW };
    return state({ status: "waiting_input", wait, stack: [frame] });
  };
  return { def, ask, after, into, node, targets, waiting };
}

const logged = (commits: { logs: { message: string }[] }[]) => commits.flatMap((c) => c.logs.map((l) => l.message));

describe("asking", () => {
  test("sends the prompt and waits for the reply", async () => {
    const c = captureBot();
    const { result, commits } = await run({ def: c.def });
    expect(texts(commits)).toEqual(["رقم الطلب كام؟"]);
    expect(result.state).toMatchObject({
      status: "waiting_input",
      wait: { kind: "capture", nodeId: c.node, cardId: c.ask, attempts: 0, since: NOW },
      stack: [{ cardIndex: 0 }],
    });
  });

  test("a choice prompt renders its options", async () => {
    const c = captureBot({
      kind: "choice",
      type: "string",
      prompt: {
        type: "choice",
        text: "تحب نكلمك إزاي يا {{ user.attributes.name }}؟",
        options: [
          { label: "واتساب", value: "whatsapp" },
          { label: "مكالمة", value: "call" },
        ],
      },
    });
    const { commits } = await run({ def: c.def, user: { vars: {}, attributes: { name: "منى" } } });
    expect(commits[0]?.messages).toEqual([
      {
        type: "choice",
        text: "تحب نكلمك إزاي يا منى؟",
        options: [
          { label: "واتساب", value: "whatsapp" },
          { label: "مكالمة", value: "call" },
        ],
      },
    ]);
  });

  test("with skipIfFilled and a valid stored value, it does not ask", async () => {
    const c = captureBot({ skipIfFilled: true });
    const { result, commits } = await run({ def: c.def, state: state({ conversationVars: { [c.into]: 45123 } }) });
    expect(texts(commits)).toEqual([]);
    expect(logged(commits)).toEqual(["after"]);
    expect(result.state.status).toBe("idle");
  });

  test("with skipIfFilled and a stored value of the wrong type, it asks", async () => {
    const c = captureBot({ skipIfFilled: true });
    const { commits } = await run({ def: c.def, state: state({ conversationVars: { [c.into]: null } }) });
    expect(texts(commits)).toEqual(["رقم الطلب كام؟"]);
  });
});

describe("a valid reply", () => {
  test("Arabic-Indic digits are captured as a number", async () => {
    const c = captureBot();
    const { result, commits } = await run({ def: c.def, state: c.waiting(), event: message("٤٥١٢٣") });
    expect(result.state.conversationVars).toEqual({ [c.into]: 45123 });
    expect(logged(commits)).toEqual(["after"]);
    expect(result.state.status).toBe("idle");
  });

  test("a postback answers with its value", async () => {
    const c = captureBot({
      kind: "choice",
      type: "string",
      prompt: { type: "choice", text: "اختار", options: [{ label: "الشحن", value: "shipping" }] },
    });
    const postback = event("message", {
      text: "الشحن",
      message: { type: "postback", value: "shipping", label: "الشحن" } as EventScope["message"],
    });
    const { result } = await run({ def: c.def, state: c.waiting(), event: postback });
    expect(result.state.conversationVars).toEqual({ [c.into]: "shipping" });
  });

  test("passes the card's validate expression, with the reply as `value`", async () => {
    const c = captureBot({
      kind: "text",
      type: "string",
      validate: { expression: "value.startsWith('ORD-')", message: "اكتب الرقم كده: ORD-12345" },
    });
    const h = harness({
      sandboxAnswers: (e, batch) => {
        if (!e.includes("value.startsWith('ORD-')")) return undefined;
        const value = (batch.scopes.turn as Record<string, unknown>)["$value"] as string;
        return { ok: true, value: value.startsWith("ORD-") };
      },
    });
    const { result } = await run({ def: c.def, h, state: c.waiting(), event: message("ORD-45123") });
    expect(result.state.conversationVars).toEqual({ [c.into]: "ORD-45123" });
    expect(h.batches).toHaveLength(1);
  });

  test("with routeByOption, a chosen option leaves through its port", async () => {
    const c = captureBot({
      kind: "choice",
      type: "string",
      routeByOption: true,
      prompt: {
        type: "choice",
        text: "اختار",
        options: [
          { label: "الشحن", value: "shipping" },
          { label: "الفواتير", value: "billing" },
        ],
      },
      connect: ["option:shipping"],
    });
    const shipped = await run({ def: c.def, state: c.waiting(), event: message("1") });
    expect(logged(shipped.commits)).toEqual(["option:shipping"]);
    // An option whose port is not connected falls through to the next card (ADR-016).
    const billed = await run({ def: c.def, state: c.waiting(), event: message("الفواتير") });
    expect(logged(billed.commits)).toEqual(["after"]);
    expect(billed.result.state.conversationVars).toEqual({ [c.into]: "billing" });
  });
});

describe("an invalid reply", () => {
  test("sends the retry message and the prompt again, counting the attempt", async () => {
    const c = captureBot({ retryMessage: "محتاج رقم بس، من غير حروف" });
    const { result, commits } = await run({ def: c.def, state: c.waiting(), event: message("الطلب رقم خمسة") });
    expect(texts(commits)).toEqual(["محتاج رقم بس، من غير حروف", "رقم الطلب كام؟"]);
    expect(result.state.wait).toMatchObject({ kind: "capture", attempts: 1, since: NOW });
    expect(result.state.conversationVars).toEqual({});
  });

  test("without a retry message, sends the prompt again", async () => {
    const c = captureBot();
    const { commits } = await run({ def: c.def, state: c.waiting(), event: message("مش عارف") });
    expect(texts(commits)).toEqual(["رقم الطلب كام؟"]);
  });

  test("a failed validate expression sends its message", async () => {
    const c = captureBot({
      validate: { expression: "value > 1000", message: "الرقم لازم يكون أكبر من {{ env.MIN }}" },
    });
    const h = harness({ sandboxAnswers: (e) => (e.includes("value > 1000") ? { ok: true, value: false } : undefined) });
    const { commits } = await run({ def: c.def, h, env: { MIN: 1000 }, state: c.waiting(), event: message("٥") });
    expect(texts(commits)).toEqual(["الرقم لازم يكون أكبر من 1000", "رقم الطلب كام؟"]);
  });

  test("a validate expression that does not give a boolean fails the step", async () => {
    const c = captureBot({ validate: { expression: "value * 2", message: "x" } });
    const h = harness({ sandboxAnswers: (e) => (e.includes("value * 2") ? { ok: true, value: 10 } : undefined) });
    const { result } = await run({ def: c.def, h, state: c.waiting(), event: message("5") });
    expect(result.error).toMatchObject({ code: "expression_error" });
    expect(result.error?.message).toContain("value * 2");
  });

  test("a non-text reply to a text question is invalid", async () => {
    const c = captureBot({ kind: "text", type: "string" });
    const image = event("message", {
      message: { type: "image", url: "https://example.com/a.png" } as EventScope["message"],
    });
    const { result } = await run({ def: c.def, state: c.waiting(), event: image });
    expect(result.state.wait).toMatchObject({ attempts: 1 });
  });

  test("after maxRetries, the card fails through its failed port", async () => {
    const c = captureBot({ maxRetries: 1, connect: ["failed"] });
    const { result, commits } = await run({ def: c.def, state: c.waiting(1), event: message("لا أعرف") });
    expect(logged(commits)).toEqual(["failed"]);
    expect(failures(commits)).toMatchObject([{ code: "validation_failed", handledBy: "port" }]);
    expect(result.state.status).toBe("idle");
  });

  test("after maxRetries with failed unconnected, error resolution takes over", async () => {
    const c = captureBot({ maxRetries: 0 });
    const { result } = await run({ def: c.def, state: c.waiting(0), event: message("x") });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("validation_failed");
  });
});

describe("kinds not built yet", () => {
  test("extract fails until the AI cards arrive", async () => {
    const c = captureBot({ kind: "extract", type: "object" });
    const { result } = await run({ def: c.def, state: c.waiting(), event: message("اسمي منى") });
    expect(result.error?.code).toBe("internal_error");
  });
});

describe("a prompt that cannot be sent", () => {
  test("fails with the template error", async () => {
    const c = captureBot({ prompt: { type: "text", text: "{{ user.name.trim() }}" } });
    const { result } = await run({ def: c.def });
    expect(result.error?.code).toBe("template_error");
  });
});

test("the step after a capture runs only once the reply is stored", async () => {
  const c = captureBot();
  const first = await run({ def: c.def });
  expect(logged(first.commits)).toEqual([]);
  const second = await run({ def: c.def, state: first.result.state, event: message("12") });
  expect(logged(second.commits)).toEqual(["after"]);
});
