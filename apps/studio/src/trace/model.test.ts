import { ERRORS, type Span, type Workflow } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { formatDuration, mergeSpan, runOverlay, stepLabel, stepRows } from "./model";

/** Task 4.7: the emulator's trace list and the canvas run overlay, as pure data. */
const T = "2026-11-14T10:00:00.000Z";
let n = 0;
const span = (kind: Span["kind"], extra: Record<string, unknown> = {}): Span => {
  n += 1;
  const attrs: Record<Span["kind"], unknown> = {
    turn: { trigger: "message", mode: "emulator" },
    node: { nodeType: "standard" },
    card: { cardType: "say", outcome: "next" },
    "code.exec": { kind: "card" },
    error: { code: "template_error", message: "Unknown variable user.nme", fix: "Check the name." },
    "autonomy.iteration": { index: 1, status: "exit" },
    "llm.call": {},
    "tool.call": {},
    "kb.search": {},
    "table.op": {},
    "webhook.delivery": {},
  };
  return {
    id: `span_01m7a256m0a13warwhczsj${String(n).padStart(4, "0")}`,
    workspaceId: "ws_01m7a256m0a13warwhczsjhx9g",
    botId: "bot_01m7a256m0a13warwhczsjhx9b",
    conversationId: "conv_01m7a256m0a13warwhczsjhx9v",
    turnId: "turn_01m7a256m0a13warwhczsjhx9t",
    seq: 0,
    name: kind,
    status: "ok",
    startedAt: T,
    durationMs: 0,
    location: {},
    kind,
    attrs: attrs[kind],
    ...extra,
  } as Span;
};

const workflow = (): Workflow =>
  ({
    id: "wf_MAINAAAAAA",
    name: "Main",
    kind: "main",
    nodes: [
      { id: "node_STARTAAAAA", type: "start", name: "Start" },
      { id: "node_GREETAAAAA", type: "standard", name: "Greet", cards: [] },
      { id: "node_TRACKAAAAA", type: "standard", name: "Track", cards: [] },
      { id: "node_OTHERAAAAA", type: "standard", name: "Other", cards: [] },
    ],
    edges: [
      { id: "edge_STARTAAAAA", from: { nodeId: "node_STARTAAAAA", port: "next" }, to: { nodeId: "node_GREETAAAAA" } },
      {
        id: "edge_TRACKAAAAA",
        from: { nodeId: "node_GREETAAAAA", port: "card:x:option:track" },
        to: { nodeId: "node_TRACKAAAAA" },
      },
      {
        id: "edge_OTHERAAAAA",
        from: { nodeId: "node_GREETAAAAA", port: "card:x:option:other" },
        to: { nodeId: "node_OTHERAAAAA" },
      },
    ],
    inputs: [],
    outputs: [],
    variables: [],
    layout: {},
  }) as unknown as Workflow;

function turnSpans() {
  const turn = span("turn", { seq: 0, durationMs: 1820 });
  const greet = span("node", {
    seq: 1,
    parentId: turn.id,
    name: "Greet",
    location: { workflowId: "wf_MAINAAAAAA", nodeId: "node_GREETAAAAA" },
  });
  const say = span("card", {
    seq: 2,
    parentId: greet.id,
    durationMs: 40,
    location: { workflowId: "wf_MAINAAAAAA", nodeId: "node_GREETAAAAA", cardId: "card_SAYAAAAAAA" },
  });
  const track = span("node", {
    seq: 3,
    parentId: turn.id,
    name: "Track",
    location: { workflowId: "wf_MAINAAAAAA", nodeId: "node_TRACKAAAAA" },
  });
  const code = span("card", {
    seq: 4,
    parentId: track.id,
    durationMs: 900,
    attrs: { cardType: "code", outcome: "next" },
    location: { workflowId: "wf_MAINAAAAAA", nodeId: "node_TRACKAAAAA", cardId: "card_CODEAAAAAA" },
  });
  const exec = span("code.exec", { seq: 5, parentId: code.id, name: "Run code", durationMs: 900 });
  const error = span("error", { seq: 6, parentId: code.id, status: "error", name: "template_error" });
  return { turn, greet, say, track, code, exec, error, all: [turn, greet, say, track, code, exec, error] };
}

describe("mergeSpan", () => {
  test("adds new spans in seq order and replaces a span that came again (it closed)", () => {
    const s = turnSpans();
    let list: Span[] = [];
    for (const x of [s.say, s.turn, s.greet]) list = mergeSpan(list, x);
    expect(list.map((x) => x.seq)).toEqual([0, 1, 2]);
    list = mergeSpan(list, { ...s.greet, durationMs: 120 } as Span);
    expect(list.map((x) => [x.seq, x.durationMs])).toEqual([
      [0, 1820],
      [1, 120],
      [2, 40],
    ]);
  });
});

describe("stepRows", () => {
  test("each span with its depth under the turn, in seq order", () => {
    expect(stepRows(turnSpans().all).map((r) => [r.span.seq, r.depth])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 3],
    ]);
  });
});

describe("stepLabel and formatDuration", () => {
  test("names follow the design system (Step, Trace) and the card's display name", () => {
    const s = turnSpans();
    const names = { say: "Say", code: "Run code" } as Record<string, string>;
    expect(stepLabel(s.turn, { botName: "Store assistant", cardNames: names })).toBe("Store assistant");
    expect(stepLabel(s.greet, { botName: "x", cardNames: names })).toBe("Greet");
    expect(stepLabel(s.code, { botName: "x", cardNames: names })).toBe("Run code");
    expect(stepLabel(s.exec, { botName: "x", cardNames: names })).toBe("Sandbox");
    // The same title the transcript's error banner shows; the step's details carry the message.
    expect(stepLabel(s.error, { botName: "x", cardNames: names })).toBe(ERRORS.template_error.title);
  });

  test("milliseconds under a second, seconds with one decimal above", () => {
    expect([0, 12, 999, 1000, 1820, 12_345].map(formatDuration)).toEqual([
      "0 ms",
      "12 ms",
      "999 ms",
      "1.0 s",
      "1.8 s",
      "12.3 s",
    ]);
  });
});

describe("runOverlay", () => {
  test("the cards, nodes and transitions a turn went through, including the one from Start", () => {
    const o = runOverlay(turnSpans().all, { wf_MAINAAAAAA: workflow() });
    expect([...o.cards].sort()).toEqual(["card_CODEAAAAAA", "card_SAYAAAAAAA"]);
    expect([...o.nodes].sort()).toEqual(["node_GREETAAAAA", "node_TRACKAAAAA"]);
    expect([...o.edges].sort()).toEqual(["edge_STARTAAAAA", "edge_TRACKAAAAA"]);
  });

  test("a turn that started mid-conversation does not light the transition from Start", () => {
    const s = turnSpans();
    const resumed = s.all.filter((x) => x !== s.greet && x !== s.say);
    const o = runOverlay(resumed, { wf_MAINAAAAAA: workflow() });
    expect([...o.edges]).toEqual([]);
    expect([...o.nodes]).toEqual(["node_TRACKAAAAA"]);
  });

  test("a turn that picked up inside the node it waited in does not light the transition from Start", () => {
    const s = turnSpans();
    // Greet has two cards; this turn's first step there is the second one: it resumed a wait.
    const wf = workflow();
    const greet = wf.nodes.find((x) => x.id === "node_GREETAAAAA") as { cards: unknown[] };
    greet.cards = [{ id: "card_ASKAAAAAAA" }, { id: "card_SAYAAAAAAA" }];
    const o = runOverlay(s.all, { wf_MAINAAAAAA: wf });
    expect([...o.edges]).toEqual(["edge_TRACKAAAAA"]);
  });

  test("a failed card is not marked as visited, so the check never sits on a card that failed", () => {
    const o = runOverlay(
      turnSpans().all.map((x) => (x.kind === "card" && x.seq === 4 ? ({ ...x, status: "error" } as Span) : x)),
      {
        wf_MAINAAAAAA: workflow(),
      },
    );
    expect([...o.cards]).toEqual(["card_SAYAAAAAAA"]);
    expect([...o.failed]).toEqual(["card_CODEAAAAAA"]);
  });
});
