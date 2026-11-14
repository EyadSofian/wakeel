import type { Frame, WaitSpec } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  capture,
  cardId,
  definition,
  edge,
  event,
  events,
  harness,
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
  wfId,
  workflow,
} from "./harness";

/**
 * Architecture §4.4, "Applying the inbound event": one test (or table) per row of the event
 * table, plus the combinations the table leaves out, which are recorded and ignored.
 */

const SINCE = "2026-11-13T08:00:00.000Z";

/** A conversation waiting in a capture card of the linear bot's node. */
function waitingCapture() {
  const ask = cardId();
  const after = cardId();
  const name = varId();
  const bot = linearBot([capture(ask, name), step(after)], {
    variables: [{ id: name, name: "name", scope: "conversation", type: "string" }],
  });
  const wait: WaitSpec = { kind: "capture", nodeId: bot.node, cardId: ask, attempts: 0, since: SINCE };
  const frame: Frame = { workflowId: bot.main.id, nodeId: bot.node, cardIndex: 0, vars: {}, inputs: {} };
  return { ...bot, ask, after, name, wait, frame, waiting: state({ status: "waiting_input", stack: [frame], wait }) };
}

/** A conversation inside an autonomous node, waiting as `wait` says. */
function waitingAutonomous(kind: "listen" | "tool", busyMessage?: string) {
  const start = nodeId();
  const agent = nodeId();
  const main = workflow({
    nodes: [
      { id: start, type: "start", name: "Start" },
      {
        id: agent,
        type: "autonomous",
        name: "Agent",
        instructions: "ساعد العميل",
        ...(busyMessage ? { busyMessage } : {}),
      },
    ],
    edges: [edge(start, "next", agent)],
  });
  const def = definition({ workflows: [main] });
  const wait: WaitSpec =
    kind === "listen"
      ? { kind: "listen", nodeId: agent, since: SINCE }
      : { kind: "tool", nodeId: agent, toolId: "tool_AAAAAAAAAA", toolCallId: "call-1", since: SINCE };
  const frame: Frame = { workflowId: main.id, nodeId: agent, cardIndex: 0, vars: {}, inputs: {} };
  const status = kind === "listen" ? "waiting_input" : "waiting_external";
  return { def, main, agent, wait, frame, waiting: state({ status, stack: [frame], wait }) };
}

describe("user_update", () => {
  test.each(["idle", "waiting_input", "handed_off", "ended"] as const)(
    "in %s merges the attributes and runs no steps",
    async (status) => {
      const capture = waitingCapture();
      const before = status === "waiting_input" ? capture.waiting : state({ status });
      const s = scripted();
      const { result, commits, ephemeral } = await run({
        def: capture.def,
        state: before,
        event: event("user_update", { payload: { attributes: { plan: "pro", city: "القاهرة" } } }),
        user: { vars: {}, attributes: { plan: "free", tier: 2 } },
        executors: s.executors,
      });
      expect(s.calls).toHaveLength(0);
      expect(commits).toHaveLength(1);
      expect(commits[0]?.user).toEqual({ attributes: { plan: "pro", tier: 2, city: "القاهرة" } });
      expect(commits[0]?.state).toEqual(before);
      expect(commits[0]?.step).toBeUndefined();
      expect(result.state).toEqual(before);
      expect(ephemeral).toEqual([]);
    },
  );

  test("without attributes changes nothing and commits nothing", async () => {
    const { commits, result } = await run({ def: linearBot([step()]).def, event: event("user_update") });
    expect(commits).toEqual([]);
    expect(result).toMatchObject({ status: "completed", stepSeq: 0 });
  });
});

describe("message", () => {
  test("in handed_off is recorded only", async () => {
    const s = scripted();
    const handedOff = state({ status: "handed_off" });
    const { result, commits } = await run({ def: linearBot([step()]).def, state: handedOff, executors: s.executors });
    expect(s.calls).toHaveLength(0);
    expect(commits).toEqual([]);
    expect(result).toMatchObject({ status: "handed_off", stepSeq: 0, state: handedOff });
  });

  test("in ended starts a new session: state reset, then Main from Start", async () => {
    const first = cardId();
    const leftover = varId();
    const bot = linearBot([step(first)], {
      variables: [{ id: leftover, name: "topic", scope: "conversation", type: "string" }],
    });
    const s = scripted({
      [first]: (ctx) => {
        // The previous session's conversation variables are gone.
        expect(ctx.scopes.conversation).toEqual({});
        return say("أهلاً من جديد");
      },
    });
    const ended = state({ status: "ended", conversationVars: { [leftover]: "شحن" }, inactivityTimeoutMinutes: 5 });
    const { result, commits } = await run({ def: bot.def, state: ended, executors: s.executors });
    expect(s.ran()).toEqual([first]);
    expect(texts(commits)).toEqual(["أهلاً من جديد"]);
    expect(result.status).toBe("completed");
    expect(result.state).toEqual(state({ status: "idle" }));
  });

  test("in idle pushes Main at Start and runs it to the end", async () => {
    const a = cardId();
    const b = cardId();
    const bot = linearBot([step(a), step(b)]);
    const s = scripted({ [a]: () => say("أهلاً"), [b]: () => say("كيف أساعدك؟") });
    const { result, commits } = await run({ def: bot.def, executors: s.executors });
    expect(s.ran()).toEqual([a, b]);
    expect(texts(commits)).toEqual(["أهلاً", "كيف أساعدك؟"]);
    expect(result).toMatchObject({ status: "completed", messageCount: 2 });
    expect(result.state.stack).toEqual([]);
  });

  test("in waiting_input (capture) feeds the reply to the waiting card", async () => {
    const c = waitingCapture();
    const reply = message("منى");
    const s = scripted({
      [c.ask]: (ctx) => {
        expect(ctx.reply).toEqual({ wait: c.wait, event: reply });
        return outcome({ type: "next" }, { writes: [{ scope: "conversation", variableId: c.name, value: "منى" }] });
      },
    });
    const { result } = await run({ def: c.def, state: c.waiting, event: reply, executors: s.executors });
    expect(s.ran()).toEqual([c.ask, c.after]);
    // Only the capture card sees the reply.
    expect(s.calls[1]?.reply).toBeUndefined();
    expect(result.state).toMatchObject({ status: "idle", stack: [], conversationVars: { [c.name]: "منى" } });
  });

  test("in waiting_input (listen) resumes the autonomous node with the message", async () => {
    const a = waitingAutonomous("listen");
    const reply = message("عايز أغير العنوان");
    const h = harness({ autonomy: () => outcome({ type: "wait", wait: { ...a.wait, since: SINCE } }) });
    const { result, autonomyCalls } = await run({ def: a.def, state: a.waiting, event: reply, h });
    expect(autonomyCalls).toHaveLength(1);
    expect(autonomyCalls[0]?.resume).toEqual({ kind: "message", event: reply });
    expect(result.state).toMatchObject({ status: "waiting_input", wait: a.wait });
  });

  test("in waiting_external queues behind the tool and sends the node's busy text", async () => {
    const a = waitingAutonomous("tool", "لحظة من فضلك، ما زلت أتحقق من طلبك");
    const h = harness({ autonomy: () => outcome({ type: "next" }) });
    const { result, commits, autonomyCalls } = await run({ def: a.def, state: a.waiting, h });
    expect(autonomyCalls).toHaveLength(0);
    expect(texts(commits)).toEqual(["لحظة من فضلك، ما زلت أتحقق من طلبك"]);
    expect(result.state).toEqual(a.waiting);
    expect(result.status).toBe("waiting");
  });

  test("in waiting_external with no busy text sends nothing", async () => {
    const a = waitingAutonomous("tool");
    const { result, commits } = await run({ def: a.def, state: a.waiting });
    expect(commits).toEqual([]);
    expect(result.state).toEqual(a.waiting);
  });

  test("in waiting_external, a busy text that fails is recorded and the tool stays pending", async () => {
    const a = waitingAutonomous("tool", "{{ workflow.items.length * 2 }}");
    const { result, commits } = await run({ def: a.def, state: a.waiting });
    expect(texts(commits)).toEqual([]);
    expect(commits[0]?.failures).toMatchObject([{ code: "template_error", handledBy: "ignored" }]);
    expect(result.state).toEqual(a.waiting);
  });
});

describe("event (custom)", () => {
  /** Main has a trigger for `order_shipped` leading to a node that says one line. */
  function triggerBot() {
    const c = waitingCapture();
    const trigger = nodeId();
    const notify = nodeId();
    const notifyCard = cardId();
    const main = {
      ...c.main,
      nodes: [
        ...c.main.nodes,
        { id: trigger, type: "trigger", name: "Shipped", on: { kind: "event", name: "order_shipped" } },
        standard(notify, [step(notifyCard)], "Notify"),
      ],
      edges: [...c.main.edges, edge(trigger, "next", notify)],
    };
    const def = definition({ workflows: [main], variables: c.def.manifest.variables });
    return { ...c, def, trigger, notifyCard };
  }

  test("a matching trigger runs, then the previous wait is restored", async () => {
    const t = triggerBot();
    const s = scripted({ [t.notifyCard]: () => say("طلبك في الطريق") });
    const { result, commits } = await run({
      def: t.def,
      state: t.waiting,
      event: event("event", { name: "order_shipped" }),
      executors: s.executors,
    });
    expect(s.ran()).toEqual([t.notifyCard]);
    expect(texts(commits)).toEqual(["طلبك في الطريق"]);
    expect(result.state).toEqual(t.waiting);
    expect(result.status).toBe("waiting");
  });

  test("a matching trigger in an idle conversation runs and leaves it idle", async () => {
    const t = triggerBot();
    const s = scripted();
    const { result } = await run({
      def: t.def,
      event: event("event", { name: "order_shipped" }),
      executors: s.executors,
    });
    expect(s.ran()).toEqual([t.notifyCard]);
    expect(result.state).toEqual(state());
  });

  test("with no matching trigger, the event is recorded and ignored", async () => {
    const t = triggerBot();
    const s = scripted();
    const { result, commits } = await run({
      def: t.def,
      state: t.waiting,
      event: event("event", { name: "payment_failed" }),
      executors: s.executors,
    });
    expect(s.calls).toEqual([]);
    expect(commits).toEqual([]);
    expect(result.state).toEqual(t.waiting);
  });

  test.each(["handed_off", "ended"] as const)("in %s nothing runs, even with a matching trigger", async (status) => {
    const t = triggerBot();
    const s = scripted();
    const { commits } = await run({
      def: t.def,
      state: state({ status }),
      event: event("event", { name: "order_shipped" }),
      executors: s.executors,
    });
    expect(s.calls).toEqual([]);
    expect(commits).toEqual([]);
  });

  test("triggers in workflows on the stack win over Main, top of the stack first", async () => {
    const subId = wfId();
    const subEntry = nodeId();
    const subTrigger = nodeId();
    const subNode = nodeId();
    const subCard = cardId();
    const mainTrigger = nodeId();
    const mainNode = nodeId();
    const mainCard = cardId();
    const ask = cardId();
    const askNode = nodeId();
    const start = nodeId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        { id: mainTrigger, type: "trigger", name: "Ping", on: { kind: "event", name: "ping" } },
        standard(mainNode, [step(mainCard)]),
      ],
      edges: [edge(mainTrigger, "next", mainNode)],
    });
    const sub = workflow({
      id: subId,
      kind: "sub",
      nodes: [
        { id: subEntry, type: "entry", name: "Entry" },
        standard(askNode, [step(ask)]),
        { id: subTrigger, type: "trigger", name: "Ping", on: { kind: "event", name: "ping" } },
        standard(subNode, [step(subCard)]),
        { id: nodeId(), type: "exit", name: "Exit" },
      ],
      edges: [edge(subEntry, "next", askNode), edge(subTrigger, "next", subNode)],
    });
    const def = definition({ workflows: [main, sub] });
    const wait: WaitSpec = { kind: "capture", nodeId: askNode, cardId: ask, attempts: 0, since: SINCE };
    const waiting = state({
      status: "waiting_input",
      wait,
      stack: [
        { workflowId: main.id, nodeId: start, cardIndex: 0, vars: {}, inputs: {} },
        { workflowId: subId, nodeId: askNode, cardIndex: 0, vars: {}, inputs: {}, call: { outputs: {} } },
      ],
    });
    const s = scripted();
    const { result } = await run({
      def,
      state: waiting,
      event: event("event", { name: "ping" }),
      executors: s.executors,
    });
    expect(s.ran()).toEqual([subCard]);
    expect(result.state).toEqual(waiting);
  });
});

describe("tool_result", () => {
  test("in waiting_external resumes the suspended tool call", async () => {
    const a = waitingAutonomous("tool");
    const ev = event("tool_result", { payload: { toolCallId: "call-1", result: { ok: true } } });
    const h = harness({ autonomy: () => outcome({ type: "goto", port: "error" }) });
    const { autonomyCalls } = await run({ def: a.def, state: a.waiting, event: ev, h });
    expect(autonomyCalls[0]?.resume).toEqual({ kind: "tool_result", toolCallId: "call-1", event: ev });
  });

  test("for a different tool call is ignored", async () => {
    const a = waitingAutonomous("tool");
    const h = harness({ autonomy: () => outcome({ type: "next" }) });
    const { result, autonomyCalls, commits } = await run({
      def: a.def,
      state: a.waiting,
      event: event("tool_result", { payload: { toolCallId: "call-2" } }),
      h,
    });
    expect(autonomyCalls).toEqual([]);
    expect(commits).toEqual([]);
    expect(result.state).toEqual(a.waiting);
  });

  test("when nothing is pending is ignored", async () => {
    const a = waitingAutonomous("listen");
    const { result, commits } = await run({
      def: a.def,
      state: a.waiting,
      event: event("tool_result", { payload: { toolCallId: "call-1" } }),
    });
    expect(commits).toEqual([]);
    expect(result.state).toEqual(a.waiting);
  });
});

describe("handoff_release", () => {
  function releaseBot(withTrigger: boolean) {
    const bot = linearBot([step()]);
    const trigger = nodeId();
    const back = nodeId();
    const backCard = cardId();
    if (!withTrigger) return { ...bot, backCard };
    const main = {
      ...bot.main,
      nodes: [
        ...bot.main.nodes,
        { id: trigger, type: "trigger", name: "Released", on: { kind: "handoff_released" } },
        standard(back, [step(backCard)]),
      ],
      edges: [...bot.main.edges, edge(trigger, "next", back)],
    };
    return { ...bot, def: definition({ workflows: [main] }), backCard };
  }

  test("in handed_off goes idle and runs the handoff_released trigger", async () => {
    const r = releaseBot(true);
    const s = scripted({ [r.backCard]: () => say("رجعت معاك تاني") });
    const { result, commits } = await run({
      def: r.def,
      state: state({ status: "handed_off" }),
      event: event("handoff_release"),
      executors: s.executors,
    });
    expect(texts(commits)).toEqual(["رجعت معاك تاني"]);
    expect(result).toMatchObject({ status: "completed", state: state() });
  });

  test("in handed_off with no trigger just goes idle", async () => {
    const r = releaseBot(false);
    const s = scripted();
    const { result, commits } = await run({
      def: r.def,
      state: state({ status: "handed_off" }),
      event: event("handoff_release"),
      executors: s.executors,
    });
    expect(s.calls).toEqual([]);
    expect(commits.map((c) => c.state)).toEqual([state()]);
    expect(result.state).toEqual(state());
  });

  test("when not handed off is ignored", async () => {
    const { commits, result } = await run({ def: releaseBot(true).def, event: event("handoff_release") });
    expect(commits).toEqual([]);
    expect(result.state).toEqual(state());
  });
});

describe("timeout", () => {
  function inactivityBot() {
    const c = waitingCapture();
    const trigger = nodeId();
    const remind = nodeId();
    const remindCard = cardId();
    const main = {
      ...c.main,
      nodes: [
        ...c.main.nodes,
        { id: trigger, type: "trigger", name: "Inactive", on: { kind: "inactivity" } },
        standard(remind, [step(remindCard)]),
      ],
      edges: [...c.main.edges, edge(trigger, "next", remind)],
    };
    return { ...c, def: definition({ workflows: [main], variables: c.def.manifest.variables }), remindCard };
  }

  test("in waiting_input runs the inactivity trigger instead of ending, then waits again", async () => {
    const t = inactivityBot();
    const s = scripted({ [t.remindCard]: () => say("لسه معايا؟") });
    const { result, commits } = await run({
      def: t.def,
      state: t.waiting,
      event: event("timeout"),
      executors: s.executors,
    });
    expect(texts(commits)).toEqual(["لسه معايا؟"]);
    expect(events(commits)).toEqual([]);
    expect(result.state).toEqual(t.waiting);
  });

  test.each(["waiting_input", "waiting_external"] as const)(
    "in %s with no inactivity trigger ends the conversation",
    async (status) => {
      const t = status === "waiting_input" ? waitingCapture() : waitingAutonomous("tool");
      const { result, commits } = await run({ def: t.def, state: t.waiting, event: event("timeout") });
      expect(events(commits)).toEqual([{ type: "conversation.ended", data: { reason: "inactivity" } }]);
      expect(result.status).toBe("ended");
      expect(result.state).toEqual(state({ status: "ended", started: undefined }));
    },
  );

  test.each(["idle", "handed_off", "ended"] as const)("in %s is ignored", async (status) => {
    const t = inactivityBot();
    const { commits } = await run({ def: t.def, state: state({ status }), event: event("timeout") });
    expect(commits).toEqual([]);
  });
});
