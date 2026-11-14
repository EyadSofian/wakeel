import type { Frame } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  capture,
  cardId,
  definition,
  edge,
  event,
  events,
  freshState,
  linearBot,
  message,
  nodeId,
  outcome,
  run,
  say,
  scripted,
  standard,
  state,
  step,
  texts,
  varId,
  workflow,
} from "./harness";

/**
 * The `conversation_started` trigger (ADR-027): the first message or custom event of a new
 * conversation, or of a new session after `ended`, runs the Main trigger's path before the work
 * the event itself starts.
 */

/** Main: Start → Greeting (one card); Trigger(conversation_started) → Welcome (one card). */
function startedBot(extraTriggers: unknown[] = []) {
  const bot = linearBot([step()]);
  const greetCard = (bot.main.nodes[1] as { cards: { id: string }[] }).cards[0]?.id as string;
  const trigger = nodeId();
  const welcome = nodeId();
  const welcomeCard = cardId();
  const main = {
    ...bot.main,
    nodes: [
      ...bot.main.nodes,
      { id: trigger, type: "trigger", name: "Started", on: { kind: "conversation_started" } },
      standard(welcome, [step(welcomeCard)], "Welcome"),
      ...extraTriggers,
    ],
    edges: [...bot.main.edges, edge(trigger, "next", welcome)],
  };
  return { ...bot, main, def: definition({ workflows: [main] }), trigger, welcome, welcomeCard, greetCard };
}

describe("conversation_started", () => {
  test("the first message runs the trigger's path, then Main from Start", async () => {
    const b = startedBot();
    const s = scripted({
      [b.welcomeCard]: () => say("أهلاً بيك في المتجر"),
      [b.greetCard]: () => say("أقدر أساعدك إزاي؟"),
    });
    const { result, commits } = await run({ def: b.def, state: freshState(), executors: s.executors });
    expect(s.ran()).toEqual([b.welcomeCard, b.greetCard]);
    expect(texts(commits)).toEqual(["أهلاً بيك في المتجر", "أقدر أساعدك إزاي؟"]);
    expect(result.status).toBe("completed");
    expect(result.state).toEqual(state({ started: true }));
  });

  test("a later message in an idle conversation does not run it again", async () => {
    const b = startedBot();
    const s = scripted();
    await run({ def: b.def, state: state({ started: true }), executors: s.executors });
    expect(s.ran()).toEqual([b.greetCard]);
  });

  test("a message after the conversation ended starts a new session and runs it again", async () => {
    const b = startedBot();
    const s = scripted();
    const { result } = await run({
      def: b.def,
      state: state({ status: "ended", started: undefined }),
      executors: s.executors,
    });
    expect(s.ran()).toEqual([b.welcomeCard, b.greetCard]);
    expect(result.state).toEqual(state({ started: true }));
  });

  test("with no trigger, the first message runs Start and marks the session started", async () => {
    const bot = linearBot([step()]);
    const s = scripted();
    const { result } = await run({ def: bot.def, state: freshState(), executors: s.executors });
    expect(s.calls).toHaveLength(1);
    expect(result.state.started).toBe(true);
  });

  test("a custom event as the first activity runs it before the event's own trigger", async () => {
    const shipped = nodeId();
    const notify = nodeId();
    const notifyCard = cardId();
    const b = startedBot([
      { id: shipped, type: "trigger", name: "Shipped", on: { kind: "event", name: "order_shipped" } },
      standard(notify, [step(notifyCard)], "Notify"),
    ]);
    const main = { ...b.main, edges: [...b.main.edges, edge(shipped, "next", notify)] };
    const s = scripted();
    const { result } = await run({
      def: definition({ workflows: [main] }),
      state: freshState(),
      event: event("event", { name: "order_shipped" }),
      executors: s.executors,
    });
    // Start is not pushed for an event: only the two trigger paths run.
    expect(s.ran()).toEqual([b.welcomeCard, notifyCard]);
    expect(result.state).toEqual(state({ started: true }));
  });

  test("a custom event as the first activity runs it even when no event trigger matches", async () => {
    const b = startedBot();
    const s = scripted();
    const { result } = await run({
      def: b.def,
      state: freshState(),
      event: event("event", { name: "conversation_started" }),
      executors: s.executors,
    });
    expect(s.ran()).toEqual([b.welcomeCard]);
    expect(result.state.started).toBe(true);
  });

  test("a trigger path that waits keeps Start below it; Start runs when that path finishes", async () => {
    const b = startedBot();
    const ask = cardId();
    const name = varId();
    const main = {
      ...b.main,
      nodes: b.main.nodes.map((n) =>
        (n as { id: string }).id === b.welcome
          ? standard(b.welcome, [capture(ask, name), step(b.welcomeCard)], "Welcome")
          : n,
      ),
    };
    const def = definition({
      workflows: [main],
      variables: [{ id: name, name: "name", scope: "conversation", type: "string" }],
    });
    const s = scripted({
      [ask]: (ctx) =>
        ctx.reply
          ? outcome(
              { type: "next" },
              { writes: [{ scope: "conversation", variableId: name, value: ctx.reply.event.text }] },
            )
          : outcome({
              type: "wait",
              wait: { kind: "capture", nodeId: b.welcome, cardId: ask, attempts: 0, since: "2026-11-14T08:00:00.000Z" },
            }),
    });

    const first = await run({ def, state: freshState(), executors: s.executors });
    expect(first.result.status).toBe("waiting");
    const stack = first.result.state.stack as Frame[];
    expect(stack.map((f) => f.nodeId)).toEqual([b.start, b.welcome]);
    expect(s.ran()).toEqual([ask]);

    const second = await run({ def, state: first.result.state, event: message("منى"), executors: s.executors });
    expect(s.ran()).toEqual([ask, ask, b.welcomeCard, b.greetCard]);
    expect(second.result.state).toEqual(state({ started: true, conversationVars: { [name]: "منى" } }));
  });

  test("a trigger path that ends the conversation drops Start", async () => {
    const b = startedBot();
    const s = scripted({ [b.welcomeCard]: () => outcome({ type: "end", reason: "completed" }) });
    const { result, commits } = await run({ def: b.def, state: freshState(), executors: s.executors });
    expect(s.ran()).toEqual([b.welcomeCard]);
    expect(events(commits)).toEqual([{ type: "conversation.ended", data: { reason: "completed" } }]);
    expect(result.status).toBe("ended");
  });

  test("user_update neither runs it nor starts the session", async () => {
    const b = startedBot();
    const s = scripted();
    const { result } = await run({
      def: b.def,
      state: freshState(),
      event: event("user_update", { payload: { attributes: { plan: "pro" } } }),
      executors: s.executors,
    });
    expect(s.calls).toEqual([]);
    expect(result.state.started).toBeUndefined();
  });

  test("Run from here starts the session without running it", async () => {
    const b = startedBot();
    const s = scripted();
    const { result } = await run({
      def: b.def,
      state: freshState(),
      event: event("run_from", { payload: { workflowId: b.main.id, nodeId: b.node } }),
      executors: s.executors,
    });
    expect(s.ran()).toEqual([b.greetCard]);
    expect(result.state.started).toBe(true);
  });

  test("a conversation_started trigger outside Main never runs", async () => {
    const bot = linearBot([step()]);
    const sub = workflow({
      nodes: [
        { id: nodeId(), type: "entry", name: "Entry" },
        { id: nodeId(), type: "trigger", name: "Started", on: { kind: "conversation_started" } },
      ],
    });
    const s = scripted();
    await run({ def: definition({ workflows: [bot.main, sub] }), state: freshState(), executors: s.executors });
    expect(s.calls).toHaveLength(1);
  });

  test("a resumed turn does not run it a second time", async () => {
    const b = startedBot();
    const s = scripted();
    // The first step (the Welcome card) committed before the worker died: the trigger frame sits
    // on top of Start, and the session is already marked started.
    const frames: Frame[] = [
      { workflowId: b.main.id, nodeId: b.start, cardIndex: 0, vars: {}, inputs: {} },
      { workflowId: b.main.id, nodeId: b.welcome, cardIndex: 1, vars: {}, inputs: {} },
    ];
    await run({
      def: b.def,
      state: state({ started: true, stack: frames }),
      committedSteps: 1,
      executors: s.executors,
    });
    expect(s.ran()).toEqual([b.greetCard]);
  });
});
