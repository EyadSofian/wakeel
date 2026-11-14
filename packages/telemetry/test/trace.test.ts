import {
  BotDefinition,
  type ConversationState,
  emptyState,
  INLINE_PAYLOAD_BYTES,
  newId,
  Span,
} from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { inlinePayload, TraceBuilder, type TraceStep } from "../src/trace";

/**
 * Task 4.7, ADR-026: spans for a turn are complete and ordered. The builder turns the worker's step
 * commits into turn, node, card, code and error spans; every span it returns parses as `Span`.
 */
const ids = {
  main: "wf_MAINAAAAAA",
  start: "node_STARTAAAAA",
  greet: "node_GREETAAAAA",
  check: "node_CHECKAAAAA",
  say: "card_SAYAAAAAAA",
  code: "card_CODEAAAAAA",
  ask: "card_ASKAAAAAAA",
  city: "var_CITYAAAAAA",
  token: "var_TOKENAAAAA",
};

const definition = BotDefinition.parse({
  schemaVersion: 1,
  manifest: {
    name: "النور",
    settings: { models: { default: "anthropic:test", utility: "anthropic:test-utility" } },
    variables: [
      { id: ids.city, name: "city", scope: "conversation", type: "string" },
      { id: ids.token, name: "token", scope: "conversation", type: "string", sensitive: true },
    ],
    mainWorkflowId: ids.main,
  },
  workflows: [
    {
      id: ids.main,
      name: "Main",
      kind: "main",
      nodes: [
        { id: ids.start, type: "start", name: "Start" },
        {
          id: ids.greet,
          type: "standard",
          name: "Greet",
          cards: [
            { id: ids.say, type: "say", message: { type: "text", text: "أهلاً" } },
            { id: ids.code, type: "code", source: "log.info('hi'); return 1" },
          ],
        },
        {
          id: ids.check,
          type: "standard",
          name: "Check",
          cards: [
            { id: ids.ask, type: "capture", kind: "text", into: ids.city, prompt: { type: "text", text: "مدينتك؟" } },
          ],
        },
      ],
      edges: [
        { id: "edge_AAAAAAAAAA", from: { nodeId: ids.start, port: "next" }, to: { nodeId: ids.greet } },
        { id: "edge_BBBBBBBBBB", from: { nodeId: ids.greet, port: "next" }, to: { nodeId: ids.check } },
      ],
      inputs: [],
      outputs: [],
      variables: [],
    },
  ],
});

const ctx = {
  workspaceId: newId("ws"),
  botId: newId("bot"),
  conversationId: newId("conv"),
  turnId: newId("turn"),
  mode: "emulator" as const,
  trigger: "message" as const,
};
const T0 = new Date("2026-11-14T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const state = (vars: Record<string, string> = {}): ConversationState => ({ ...emptyState(), conversationVars: vars });

const step = (
  n: number,
  nodeId: string,
  cardId: string | undefined,
  outcome: string,
  extra: Partial<TraceStep> = {},
): TraceStep => ({
  stepSeq: n,
  state: state(),
  failures: [],
  logs: [],
  step: { workflowId: ids.main, nodeId, ...(cardId ? { cardId } : {}), outcome: outcome as never },
  ...extra,
});

/** Applies upserts in order, as the store does: the latest copy of each span id wins. */
function store(batches: Span[][]): Span[] {
  const byId = new Map<string, Span>();
  for (const batch of batches) for (const span of batch) byId.set(span.id, span);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function runTurn() {
  const b = new TraceBuilder(ctx, definition);
  const before = { state: state(), user: { vars: {}, attributes: {} } };
  const batches: Span[][] = [];
  batches.push(b.turnStarted(T0));
  batches.push(b.stepCommitted(step(1, ids.start, undefined, "next"), before, at(5)));
  batches.push(b.stepCommitted(step(2, ids.greet, ids.say, "next"), before, at(15)));
  batches.push(
    b.stepCommitted(
      step(3, ids.greet, ids.code, "next", {
        state: state({ [ids.city]: "القاهرة", [ids.token]: "sk-live-123" }),
        logs: [{ level: "info", message: "hi" }],
      }),
      before,
      at(120),
    ),
  );
  const after = {
    state: state({ [ids.city]: "القاهرة", [ids.token]: "sk-live-123" }),
    user: { vars: {}, attributes: {} },
  };
  batches.push(
    b.stepCommitted(
      step(4, ids.check, ids.ask, "wait", {
        failures: [
          {
            code: "template_error",
            message: "Unknown variable user.nme",
            fix: "Check the variable name.",
            location: { workflowId: ids.main, nodeId: ids.check, cardId: ids.ask },
            handledBy: "ignored",
          },
        ],
      }),
      after,
      at(130),
    ),
  );
  batches.push(b.turnFinished({ status: "waiting", stepSeq: 4 }, at(140)));
  return { b, batches, spans: store(batches) };
}

describe("TraceBuilder", () => {
  test("every span parses as the contract's Span", () => {
    for (const s of runTurn().spans) expect(Span.safeParse(s).success, JSON.stringify(s)).toBe(true);
  });

  test("a turn gives turn, node, card, code and error spans, complete and ordered by seq", () => {
    const { spans } = runTurn();
    expect(spans.map((s) => [s.seq, s.kind, s.name])).toEqual([
      [0, "turn", "Turn"],
      [1, "node", "Start"],
      [2, "node", "Greet"],
      [3, "card", "say"],
      [4, "card", "code"],
      [5, "code.exec", "Run code"],
      [6, "node", "Check"],
      [7, "card", "capture"],
      [8, "error", "template_error"],
    ]);
    const turn = spans[0];
    // Parents: nodes under the turn, cards under their node, code and errors under their card.
    const parent = (seq: number) => spans.find((s) => s.id === spans[seq]?.parentId)?.seq;
    expect([1, 2, 6].map(parent)).toEqual([0, 0, 0]);
    expect([3, 4].map(parent)).toEqual([2, 2]);
    expect(parent(5)).toBe(4);
    expect(parent(8)).toBe(7);
    expect(turn?.parentId).toBeUndefined();
  });

  test("durations: a card runs from the previous commit to its own; nodes and the turn close when left", () => {
    const { spans } = runTurn();
    const bySeq = (n: number) => spans[n] as Span;
    expect(bySeq(3)).toMatchObject({ startedAt: at(5).toISOString(), durationMs: 10 });
    expect(bySeq(4)).toMatchObject({ startedAt: at(15).toISOString(), durationMs: 105 });
    expect(bySeq(2)).toMatchObject({ startedAt: at(5).toISOString(), durationMs: 115, attrs: { leftBy: "next" } });
    expect(bySeq(6)).toMatchObject({ durationMs: 20, attrs: { leftBy: "wait" } });
    expect(bySeq(0)).toMatchObject({
      durationMs: 140,
      status: "ok",
      attrs: { trigger: "message", mode: "emulator", outcome: "waiting", stepCount: 4 },
    });
  });

  test("a card records the variables it changed; sensitive values are redacted before write", () => {
    const code = runTurn().spans[4] as Extract<Span, { kind: "card" }>;
    expect(code.attrs.writes).toEqual({
      [ids.city]: { before: null, after: "القاهرة" },
      [ids.token]: { before: "[redacted]", after: "[redacted]" },
    });
    expect(JSON.stringify(runTurn().spans)).not.toContain("sk-live-123");
  });

  test("code cards carry their source and logs inline", () => {
    const exec = runTurn().spans[5] as Extract<Span, { kind: "code.exec" }>;
    expect(exec.attrs).toMatchObject({
      kind: "card",
      source: { inline: true, value: "log.info('hi'); return 1" },
      logs: { inline: true, value: [{ level: "info", message: "hi" }] },
    });
  });

  test("a failure is an error span with its code, message, fix and handling, and marks its card", () => {
    const { spans } = runTurn();
    expect(spans[8]).toMatchObject({
      kind: "error",
      status: "error",
      location: { workflowId: ids.main, nodeId: ids.check, cardId: ids.ask },
      attrs: {
        code: "template_error",
        message: "Unknown variable user.nme",
        fix: "Check the variable name.",
        handledBy: "ignored",
      },
    });
    expect(spans[7]?.status).toBe("error");
  });

  test("turn and node spans are written when they start, so a live list can show them at once", () => {
    const { batches } = runTurn();
    expect(batches[0]?.map((s) => [s.kind, s.durationMs])).toEqual([["turn", 0]]);
    expect(batches[1]?.map((s) => s.kind)).toEqual(["node"]);
  });

  test("span ids are derived from the turn and seq: the same turn gives the same ids", () => {
    const a = runTurn().spans.map((s) => s.id);
    const b = runTurn().spans.map((s) => s.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  test("a resumed turn continues from the stored spans: seq, the open node and the turn's start", () => {
    const full = runTurn().spans;
    // A worker died after step 3 was committed and traced; the stored spans are those up to seq 5.
    const stored = store([runTurn().batches.slice(0, 4).flat()]);
    const b = new TraceBuilder(ctx, definition, stored);
    expect(b.turnStarted(at(500))).toEqual([]);
    const before = { state: state({ [ids.city]: "القاهرة" }), user: { vars: {}, attributes: {} } };
    const out = b.stepCommitted(step(4, ids.check, ids.ask, "wait"), before, at(530));
    // The open Greet node is closed and Check opens at the next free seq.
    expect(out.map((s) => [s.seq, s.kind, s.name])).toEqual([
      [2, "node", "Greet"],
      [6, "node", "Check"],
      [7, "card", "capture"],
    ]);
    expect(out[0]?.startedAt).toBe(full[2]?.startedAt);
    const turn = b.turnFinished({ status: "waiting", stepSeq: 4 }, at(540)).find((s) => s.kind === "turn");
    expect(turn).toMatchObject({ startedAt: T0.toISOString(), durationMs: 540 });
  });

  test("a failed turn is an error span at the top; a commit with no step puts its failures under the turn", () => {
    const b = new TraceBuilder(ctx, definition);
    b.turnStarted(T0);
    const out = b.stepCommitted(
      {
        stepSeq: 1,
        state: state(),
        logs: [],
        failures: [
          {
            code: "message_invalid",
            message: "Busy text is empty",
            fix: "Write a busy message.",
            location: { workflowId: ids.main, nodeId: ids.greet },
            handledBy: "ignored",
          },
        ],
      },
      { state: state(), user: { vars: {}, attributes: {} } },
      at(3),
    );
    expect(out.map((s) => [s.kind, s.parentId])).toEqual([["error", b.turnSpanId]]);
    const end = b.turnFinished({ status: "failed", stepSeq: 1 }, at(4));
    expect(end.find((s) => s.kind === "turn")).toMatchObject({ status: "error", attrs: { outcome: "failed" } });
  });
});

describe("inlinePayload", () => {
  test("small values stay inline; large ones keep a preview and their size (object store arrives later)", () => {
    expect(inlinePayload({ a: "مرحبا" })).toEqual({ inline: true, value: { a: "مرحبا" } });
    const big = "س".repeat(INLINE_PAYLOAD_BYTES);
    const p = inlinePayload(big);
    expect(p).toMatchObject({ inline: false, key: "" });
    expect(p.inline === false && p.preview.length).toBe(400);
    expect(p.inline === false && p.bytes).toBeGreaterThan(INLINE_PAYLOAD_BYTES);
  });
});
