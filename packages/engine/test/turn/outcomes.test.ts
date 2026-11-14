import type { WaitSpec } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  callCard,
  cardId,
  definition,
  edge,
  events,
  failures,
  harness,
  linearBot,
  next,
  nodeId,
  outcome,
  run,
  scripted,
  standard,
  state,
  step,
  texts,
  varId,
  wfId,
  workflow,
} from "./harness";

/** Architecture §4.4 "Step loop": every outcome a card can return, and how ports are followed. */

const SINCE = "2026-11-13T08:00:00.000Z";

describe("next", () => {
  test("advances to the next card; disabled cards are skipped without a step", async () => {
    const a = cardId();
    const off = cardId();
    const b = cardId();
    const bot = linearBot([step(a), step(off, { disabled: true }), step(b)]);
    const s = scripted();
    const { result } = await run({ def: bot.def, executors: s.executors });
    expect(s.ran()).toEqual([a, b]);
    expect(result.stepSeq).toBe(2);
  });

  test("after the last card follows the node's next port", async () => {
    const a = cardId();
    const b = cardId();
    const start = nodeId();
    const first = nodeId();
    const second = nodeId();
    const main = workflow({
      nodes: [{ id: start, type: "start", name: "Start" }, standard(first, [step(a)]), standard(second, [step(b)])],
      edges: [edge(start, "next", first), edge(first, "next", second)],
    });
    const s = scripted();
    await run({ def: definition({ workflows: [main] }), executors: s.executors });
    expect(s.ran()).toEqual([a, b]);
  });

  test("a Start node with nothing connected leaves the conversation idle", async () => {
    const main = workflow({ nodes: [{ id: nodeId(), type: "start", name: "Start" }] });
    const { result, ephemeral } = await run({ def: definition({ workflows: [main] }) });
    expect(result).toMatchObject({ status: "completed", state: state() });
    // A turn that pushed a frame shows typing, even if it finished without a step.
    expect(ephemeral.map((e) => e.data.state)).toEqual(["on", "off"]);
  });
});

describe("goto", () => {
  function branchBot() {
    const branch = cardId();
    const after = cardId();
    const target = cardId();
    const start = nodeId();
    const node = nodeId();
    const other = nodeId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        standard(node, [
          { id: branch, type: "branch", branches: [{ id: "br_AAAAAAAAAA", label: "VIP", when: "user.vip" }] },
          step(after),
        ]),
        standard(other, [step(target)]),
      ],
      edges: [edge(start, "next", node), edge(node, `card:${branch}:branch:br_AAAAAAAAAA`, other)],
    });
    return { def: definition({ workflows: [main] }), branch, after, target, other };
  }

  test("a connected card port moves to the node it leads to", async () => {
    const b = branchBot();
    const s = scripted({ [b.branch]: () => outcome({ type: "goto", port: "branch:br_AAAAAAAAAA" }) });
    await run({ def: b.def, executors: s.executors });
    expect(s.ran()).toEqual([b.branch, b.target]);
  });

  test("an unconnected card port falls through to the next card (ADR-016)", async () => {
    const b = branchBot();
    const s = scripted({ [b.branch]: () => outcome({ type: "goto", port: "branch:br_BBBBBBBBBB" }) });
    await run({ def: b.def, executors: s.executors });
    expect(s.ran()).toEqual([b.branch, b.after]);
  });

  function agentBot(connected: boolean) {
    const start = nodeId();
    const agent = nodeId();
    const done = nodeId();
    const doneCard = cardId();
    const exitId = "exit_AAAAAAAAAA";
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        {
          id: agent,
          type: "autonomous",
          name: "Agent",
          instructions: "ساعد",
          exits: [{ id: exitId, name: "done", description: "انتهى" }],
        },
        standard(done, [step(doneCard)]),
      ],
      edges: [edge(start, "next", agent), ...(connected ? [edge(agent, `exit:${exitId}`, done)] : [])],
    });
    return { def: definition({ workflows: [main] }), doneCard, exitId };
  }

  test("an autonomous node leaves through a connected exit", async () => {
    const a = agentBot(true);
    let iterations = 0;
    const h = harness({
      autonomy: () =>
        ++iterations < 3 ? outcome({ type: "next" }) : outcome({ type: "goto", port: `exit:${a.exitId}` }),
    });
    const s = scripted();
    const { result } = await run({ def: a.def, h, executors: s.executors });
    // `next` from an autonomous node is another iteration of the same node.
    expect(h.autonomyCalls.map((c) => c.stepSeq)).toEqual([1, 2, 3]);
    expect(s.ran()).toEqual([a.doneCard]);
    expect(result.state.autonomy).toHaveProperty(`${a.def.manifest.mainWorkflowId}:${h.autonomyCalls[0]?.node.id}`);
  });

  test("an unconnected autonomous exit is no_route", async () => {
    const a = agentBot(false);
    const h = harness({ autonomy: () => outcome({ type: "goto", port: `exit:${a.exitId}` }) });
    const { result, commits } = await run({ def: a.def, h });
    expect(result.error?.code).toBe("no_route");
    expect(failures(commits)).toMatchObject([{ code: "no_route", handledBy: "default" }]);
  });
});

describe("wait", () => {
  test.each([
    ["capture", "waiting_input"],
    ["tool", "waiting_external"],
  ] as const)("a %s wait persists with status %s and the cursor on the card", async (kind, status) => {
    const a = cardId();
    const b = cardId();
    const after = cardId();
    const bot = linearBot([step(a), step(b), step(after)]);
    const wait: WaitSpec =
      kind === "capture"
        ? { kind, nodeId: bot.node, cardId: b, attempts: 0, since: SINCE }
        : { kind, nodeId: bot.node, toolId: "tool_AAAAAAAAAA", toolCallId: "c1", since: SINCE };
    const s = scripted({
      [b]: () =>
        outcome({ type: "wait", wait }, { messages: [{ type: "text", text: "رقم الطلب؟", format: "markdown" }] }),
    });
    const { result, commits } = await run({ def: bot.def, executors: s.executors });
    expect(s.ran()).toEqual([a, b]);
    expect(texts(commits)).toEqual(["رقم الطلب؟"]);
    expect(result.status).toBe("waiting");
    expect(result.state).toMatchObject({ status, wait, stack: [{ nodeId: bot.node, cardIndex: 1 }] });
  });
});

describe("call and return", () => {
  /**
   * Main calls a sub-workflow `Lookup(orderId) → status`; the sub's one card runs, then its Exit
   * node returns `workflow.found` as `status`.
   */
  function callBot(options: { exit?: Record<string, string>; outputs?: Record<string, string> } = {}) {
    const subId = wfId();
    const entry = nodeId();
    const body = nodeId();
    const exit = nodeId();
    const bodyCard = cardId();
    const found = varId();
    const sub = workflow({
      id: subId,
      kind: "sub",
      name: "Lookup",
      inputs: [
        { name: "orderId", type: "string" },
        { name: "note", type: "string", required: false },
      ],
      outputs: [{ name: "status", type: "string" }],
      variables: [{ id: found, name: "found", scope: "workflow", type: "string" }],
      nodes: [
        { id: entry, type: "entry", name: "Entry" },
        standard(body, [step(bodyCard)]),
        { id: exit, type: "exit", name: "Exit", outputs: options.exit ?? { status: "workflow.found" } },
      ],
      edges: [edge(entry, "next", body), edge(body, "next", exit)],
    });
    const call = cardId();
    const after = cardId();
    const status = varId();
    const local = varId();
    const start = nodeId();
    const node = nodeId();
    const main = workflow({
      nodes: [{ id: start, type: "start", name: "Start" }, standard(node, [callCard(call, subId), step(after)])],
      edges: [edge(start, "next", node)],
      variables: [{ id: local, name: "local", scope: "workflow", type: "string" }],
    });
    const def = definition({
      workflows: [main, sub],
      variables: [
        { id: status, name: "orderStatus", scope: "conversation", type: "string" },
        { id: "var_BOTBOTBOT0", name: "brand", scope: "bot", type: "string", default: "النور" },
      ],
    });
    return { def, subId, bodyCard, found, call, after, status, local, main };
  }

  test("pushes the sub-workflow with its inputs, then maps its outputs back to the caller", async () => {
    const c = callBot();
    const s = scripted({
      [c.call]: () =>
        outcome({ type: "call", workflowId: c.subId, inputs: { orderId: "ORD-45123" }, outputs: { status: c.status } }),
      [c.bodyCard]: (ctx) => {
        expect(ctx.scopes.workflow).toEqual({ orderId: "ORD-45123" });
        return outcome({ type: "next" }, { writes: [{ scope: "workflow", variableId: c.found, value: "تم الشحن" }] });
      },
      [c.after]: (ctx) => {
        expect(ctx.scopes.conversation).toEqual({ orderStatus: "تم الشحن" });
        return next();
      },
    });
    const { result } = await run({ def: c.def, executors: s.executors });
    expect(s.ran()).toEqual([c.call, c.bodyCard, c.after]);
    expect(result.state).toMatchObject({ status: "idle", stack: [], conversationVars: { [c.status]: "تم الشحن" } });
  });

  test("outputs can land in the caller's workflow variables", async () => {
    const c = callBot();
    const s = scripted({
      [c.call]: () =>
        outcome({ type: "call", workflowId: c.subId, inputs: { orderId: "1" }, outputs: { status: c.local } }),
      [c.bodyCard]: () => outcome({ type: "return", outputs: { status: "ok", extra: 1 } }),
      [c.after]: (ctx) => {
        expect(ctx.scopes.workflow).toEqual({ local: "ok" });
        return next();
      },
    });
    await run({ def: c.def, executors: s.executors });
    expect(s.ran()).toEqual([c.call, c.bodyCard, c.after]);
  });

  test("a missing required input is workflow_input_missing", async () => {
    const c = callBot();
    const s = scripted({ [c.call]: () => outcome({ type: "call", workflowId: c.subId, inputs: {}, outputs: {} }) });
    const { result } = await run({ def: c.def, executors: s.executors });
    expect(result.error).toMatchObject({ code: "workflow_input_missing" });
    expect(result.error?.message).toContain('"Lookup" needs a value for "orderId"');
  });

  test("an input of the wrong type is variable_type_mismatch", async () => {
    const c = callBot();
    const s = scripted({
      [c.call]: () => outcome({ type: "call", workflowId: c.subId, inputs: { orderId: 45123 }, outputs: {} }),
    });
    const { result } = await run({ def: c.def, executors: s.executors });
    expect(result.error?.message).toBe('"orderId" expects string but received number');
  });

  test("calling a workflow that is not a sub-workflow is not_found", async () => {
    const c = callBot();
    const s = scripted({ [c.call]: () => outcome({ type: "call", workflowId: c.main.id, inputs: {}, outputs: {} }) });
    const { result } = await run({ def: c.def, executors: s.executors });
    expect(result.error?.code).toBe("not_found");
  });

  test("an output mapped to a bot variable is write_not_allowed", async () => {
    const c = callBot();
    const s = scripted({
      [c.call]: () =>
        outcome({
          type: "call",
          workflowId: c.subId,
          inputs: { orderId: "1" },
          outputs: { status: "var_BOTBOTBOT0" },
        }),
      [c.bodyCard]: () => outcome({ type: "return", outputs: { status: "x" } }),
    });
    const { result } = await run({ def: c.def, executors: s.executors });
    expect(result.error?.code).toBe("write_not_allowed");
  });

  test("an Exit node whose expression fails is expression_error", async () => {
    const c = callBot({ exit: { status: "workflow.found.toUpperCase()" } });
    const s = scripted({
      [c.call]: () => outcome({ type: "call", workflowId: c.subId, inputs: { orderId: "1" }, outputs: {} }),
    });
    const { result } = await run({ def: c.def, executors: s.executors });
    expect(result.error?.code).toBe("expression_error");
  });

  test("an Exit node with an output that evaluates to undefined returns without it", async () => {
    const c = callBot({ exit: { status: "workflow.nothing" } });
    const s = scripted({
      [c.call]: () =>
        outcome({ type: "call", workflowId: c.subId, inputs: { orderId: "1" }, outputs: { status: c.status } }),
    });
    const { result } = await run({ def: c.def, executors: s.executors });
    expect(result.state.conversationVars).toEqual({});
  });

  test("a sub-workflow whose path ends returns implicitly with no outputs", async () => {
    const subId = wfId();
    const entry = nodeId();
    const body = nodeId();
    const bodyCard = cardId();
    const sub = workflow({
      id: subId,
      kind: "sub",
      nodes: [{ id: entry, type: "entry", name: "Entry" }, standard(body, [step(bodyCard)])],
      edges: [edge(entry, "next", body)],
    });
    const call = cardId();
    const after = cardId();
    const bot = linearBot([callCard(call, subId), step(after)], { workflows: [sub] });
    const s = scripted({ [call]: () => outcome({ type: "call", workflowId: subId, inputs: {}, outputs: {} }) });
    const { result } = await run({ def: bot.def, executors: s.executors });
    expect(s.ran()).toEqual([call, bodyCard, after]);
    expect(result.state.stack).toEqual([]);
  });

  test("a workflow called as a tool hands its outputs to the autonomous node's next iteration", async () => {
    const subId = wfId();
    const entry = nodeId();
    const sub = workflow({
      id: subId,
      kind: "sub",
      nodes: [
        { id: entry, type: "entry", name: "Entry" },
        { id: nodeId(), type: "exit", name: "Exit" },
      ],
    });
    const start = nodeId();
    const agent = nodeId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        { id: agent, type: "autonomous", name: "Agent", instructions: "ساعد" },
      ],
      edges: [edge(start, "next", agent)],
    });
    const def = definition({ workflows: [main, sub] });
    let calls = 0;
    const h = harness({
      autonomy: (input) => {
        calls++;
        if (calls === 1)
          return outcome({ type: "call", workflowId: subId, inputs: {}, toolCallId: "tc-9", outputs: {} });
        expect(input.memory?.feedback).toEqual([
          { kind: "tool_resumed", text: JSON.stringify({ toolCallId: "tc-9", outputs: {} }) },
        ]);
        return {
          ...outcome({ type: "wait", wait: { kind: "listen", nodeId: agent, since: SINCE } }),
          memory: input.memory,
        };
      },
    });
    const { result } = await run({ def, h });
    expect(calls).toBe(2);
    expect(result.state.status).toBe("waiting_input");
  });
});

describe("handoff", () => {
  test("clears the stack, emits handoff.requested and silences the bot", async () => {
    const a = cardId();
    const later = cardId();
    const bot = linearBot([step(a), step(later)]);
    const s = scripted({
      [a]: () =>
        outcome(
          {
            type: "handoff",
            reason: "طلب استرجاع",
            summary: "العميل يريد استرجاع طلبه",
            variables: { orderId: "45123" },
          },
          { messages: [{ type: "text", text: "هحولك لزميل", format: "markdown" }] },
        ),
    });
    const { result, commits } = await run({ def: bot.def, executors: s.executors });
    expect(s.ran()).toEqual([a]);
    expect(texts(commits)).toEqual(["هحولك لزميل"]);
    expect(events(commits)).toEqual([
      {
        type: "handoff.requested",
        data: { reason: "طلب استرجاع", summary: "العميل يريد استرجاع طلبه", variables: { orderId: "45123" } },
      },
    ]);
    expect(result).toMatchObject({ status: "handed_off", state: state({ status: "handed_off" }) });
  });
});

describe("end", () => {
  test.each([
    ["completed", { reason: "completed" }],
    ["manual", { reason: "manual" }],
    ["تم حل المشكلة", { reason: "completed", detail: "تم حل المشكلة" }],
  ])("end(%s) clears the conversation state and emits conversation.ended", async (reason, data) => {
    const a = cardId();
    const v = varId();
    const u = varId();
    const bot = linearBot([step(a)], {
      variables: [
        { id: v, name: "topic", scope: "conversation", type: "string" },
        { id: u, name: "tier", scope: "user", type: "string" },
      ],
    });
    const s = scripted({
      [a]: () =>
        outcome(
          { type: "end", reason },
          {
            writes: [
              { scope: "conversation", variableId: v, value: "x" },
              { scope: "user", variableId: u, value: "gold" },
            ],
          },
        ),
    });
    const { result, commits } = await run({ def: bot.def, executors: s.executors });
    expect(events(commits)).toEqual([{ type: "conversation.ended", data }]);
    expect(result).toMatchObject({ status: "ended", state: state({ status: "ended" }) });
    // User variables outlive the conversation.
    expect(commits.at(-1)?.user).toEqual({ vars: { [u]: "gold" } });
  });

  test("an End node renders its reason", async () => {
    const start = nodeId();
    const end = nodeId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        { id: end, type: "end", name: "End", reason: "{{ env.REASON }}" },
      ],
      edges: [edge(start, "next", end)],
    });
    const { result, commits } = await run({ def: definition({ workflows: [main] }), env: { REASON: "manual" } });
    expect(events(commits)).toEqual([{ type: "conversation.ended", data: { reason: "manual" } }]);
    expect(result.status).toBe("ended");
  });

  test("an End node whose reason fails to render fails the turn", async () => {
    const start = nodeId();
    const end = nodeId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        { id: end, type: "end", name: "End", reason: "{{ env.REASON.trim() }}" },
      ],
      edges: [edge(start, "next", end)],
    });
    const { result } = await run({ def: definition({ workflows: [main] }) });
    expect(result.error?.code).toBe("template_error");
  });
});

describe("scopes", () => {
  test("cards see every scope by name, with defaults for values never written", async () => {
    const a = cardId();
    const ids = { bot: varId(), user: varId(), conv: varId(), conv2: varId() };
    const bot = linearBot([step(a)], {
      variables: [
        { id: ids.bot, name: "brand", scope: "bot", type: "string", default: "النور" },
        { id: ids.user, name: "tier", scope: "user", type: "string", default: "basic" },
        { id: ids.conv, name: "topic", scope: "conversation", type: "string" },
        { id: ids.conv2, name: "count", scope: "conversation", type: "number", default: 0 },
      ],
    });
    const s = scripted({
      [a]: (ctx) => {
        expect(ctx.scopes).toEqual({
          bot: { brand: "النور" },
          user: { tier: "gold", attributes: { plan: "pro" } },
          conversation: { topic: "الشحن", count: 0 },
          workflow: {},
          event: expect.objectContaining({ kind: "message", text: "مرحبا" }),
          env: { CURRENCY: "EGP" },
          turn: {},
        });
        expect(ctx.idempotencyKey).toBe(`${ctx.turnId}:1`);
        return next();
      },
    });
    await run({
      def: bot.def,
      executors: s.executors,
      state: state({ conversationVars: { [ids.conv]: "الشحن" } }),
      user: { vars: { [ids.user]: "gold" }, attributes: { plan: "pro" } },
      env: { CURRENCY: "EGP" },
    });
    expect(s.calls).toHaveLength(1);
  });
});
