import { LIMITS, STATE_MAX_BYTES } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  callCard,
  cardId,
  definition,
  edge,
  failures,
  harness,
  linearBot,
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

/** Architecture §4.4 "Limits": each one fails the turn with its own code. */

describe("steps per turn", () => {
  test("the platform cap of 200 stops a long run at step 201", async () => {
    // Five nodes of 50 cards each: 250 steps, no node visited twice.
    const start = nodeId();
    const nodes = Array.from({ length: 5 }, () => nodeId());
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        ...nodes.map((id) =>
          standard(
            id,
            Array.from({ length: 50 }, () => step()),
          ),
        ),
      ],
      edges: [
        edge(start, "next", nodes[0] as string),
        ...nodes.slice(1).map((id, i) => edge(nodes[i] as string, "next", id)),
      ],
    });
    const s = scripted();
    const { result } = await run({ def: definition({ workflows: [main] }), executors: s.executors });
    expect(s.calls).toHaveLength(LIMITS.stepsPerTurn);
    expect(result.error).toMatchObject({ code: "step_limit_exceeded" });
    expect(result.error?.message).toBe("The bot ran 200 steps without finishing");
  });

  test("a bot's lower limit applies", async () => {
    const bot = linearBot(
      Array.from({ length: 20 }, () => step()),
      { settings: { limits: { stepsPerTurn: 10, turnSeconds: 120 } } },
    );
    const s = scripted();
    const { result } = await run({ def: bot.def, executors: s.executors });
    expect(s.calls).toHaveLength(10);
    expect(result.error?.message).toBe("The bot ran 10 steps without finishing");
  });
});

describe("visits to one node", () => {
  test("the 26th visit to a node in one turn is node_loop_detected", async () => {
    const start = nodeId();
    const loop = nodeId();
    const main = workflow({
      nodes: [{ id: start, type: "start", name: "Start" }, standard(loop, [step()], "Ask again")],
      edges: [edge(start, "next", loop), edge(loop, "next", loop)],
    });
    const s = scripted();
    const { result, commits } = await run({ def: definition({ workflows: [main] }), executors: s.executors });
    expect(s.calls).toHaveLength(LIMITS.nodeVisitsPerTurn);
    expect(result.error?.message).toBe('"Ask again" ran 25 times in one turn');
    expect(failures(commits)).toMatchObject([{ code: "node_loop_detected", location: { nodeId: loop } }]);
  });

  test("a loop of empty nodes, which runs no steps, is caught too", async () => {
    const start = nodeId();
    const a = nodeId();
    const b = nodeId();
    const main = workflow({
      nodes: [{ id: start, type: "start", name: "Start" }, standard(a, []), standard(b, [])],
      edges: [edge(start, "next", a), edge(a, "next", b), edge(b, "next", a)],
    });
    const { result } = await run({ def: definition({ workflows: [main] }) });
    expect(result.error?.code).toBe("node_loop_detected");
  });
});

describe("stack depth", () => {
  test("a workflow that calls itself fails with stack_overflow at depth 16", async () => {
    const subId = wfId();
    const entry = nodeId();
    const body = nodeId();
    const recurse = cardId();
    const sub = workflow({
      id: subId,
      kind: "sub",
      nodes: [{ id: entry, type: "entry", name: "Entry" }, standard(body, [callCard(recurse, subId)])],
      edges: [edge(entry, "next", body)],
    });
    const first = cardId();
    const bot = linearBot([callCard(first, subId)], { workflows: [sub] });
    const call = () => outcome({ type: "call", workflowId: subId, inputs: {}, outputs: {} });
    const s = scripted({ [first]: call, [recurse]: call });
    const { result, commits } = await run({ def: bot.def, executors: s.executors });
    // Main plus 15 nested calls fill the stack; the 16th call fails.
    expect(s.calls).toHaveLength(LIMITS.stackDepth);
    expect(result.error?.message).toBe("Workflows are nested more than 16 deep");
    expect(failures(commits)[0]?.location).toEqual({ workflowId: subId, nodeId: body, cardId: recurse });
  });
});

describe("turn wall clock", () => {
  test("no step starts after the turn's time runs out", async () => {
    const slow = cardId();
    const after = cardId();
    const bot = linearBot([step(slow), step(after)], { settings: { limits: { stepsPerTurn: 200, turnSeconds: 30 } } });
    const h = harness();
    const s = scripted({
      [slow]: async (ctx) => {
        expect(ctx.deadline).toBe(ctx.now + 30_000);
        await h.clock.advance(30_000);
        return say("خلصت");
      },
    });
    const { result, commits } = await run({ def: bot.def, h, executors: s.executors });
    expect(s.ran()).toEqual([slow]);
    expect(result.error?.message).toBe("The bot took longer than 30 seconds");
    // The slow step's own output was committed before the limit stopped the turn.
    expect(texts(commits)[0]).toBe("خلصت");
  });

  test("a turn resumed after a crash counts from when it first started", async () => {
    const bot = linearBot([step()]);
    const h = harness();
    const running = state({
      stack: [{ workflowId: bot.main.id, nodeId: bot.node, cardIndex: 0, vars: {}, inputs: {} }],
    });
    const s = scripted();
    const { result } = await run({
      def: bot.def,
      h,
      state: running,
      committedSteps: 3,
      startedAt: h.clock.now() - 120_000,
      executors: s.executors,
    });
    expect(s.calls).toHaveLength(0);
    expect(result.error?.code).toBe("turn_timeout");
    expect(result.stepSeq).toBe(4);
  });
});

describe("state size", () => {
  test("a step that grows the state past 256 KB is undone and fails with the largest variables", async () => {
    const big = varId();
    const small = varId();
    const a = cardId();
    const bot = linearBot([step(a)], {
      variables: [
        { id: big, name: "catalogue", scope: "conversation", type: "string" },
        { id: small, name: "note", scope: "conversation", type: "string" },
      ],
    });
    // Arabic letters take two bytes: 140,000 of them is about 280 KB.
    const s = scripted({
      [a]: () =>
        outcome(
          { type: "next" },
          {
            messages: [{ type: "text", text: "لن تُرسل", format: "markdown" }],
            writes: [
              { scope: "conversation", variableId: big, value: "ب".repeat(140_000) },
              { scope: "conversation", variableId: small, value: "صغير" },
            ],
          },
        ),
    });
    const before = state({ conversationVars: { [small]: "قديم" } });
    const { result, commits } = await run({ def: bot.def, state: before, executors: s.executors });
    expect(result.error?.code).toBe("state_too_large");
    expect(result.error?.fix).toBe(
      "Store ids instead of whole records. Largest variables: conversation.catalogue, conversation.note.",
    );
    // Nothing from the step survives; only the default error message is sent.
    expect(texts(commits)).toEqual(["Something went wrong on our side. Please try again in a moment."]);
    expect(result.state.conversationVars).toEqual({ [small]: "قديم" });
    expect(JSON.stringify(result.state).length).toBeLessThan(STATE_MAX_BYTES);
  });

  test("workflow variables and inputs are named too", async () => {
    const subId = wfId();
    const entry = nodeId();
    const body = nodeId();
    const grow = cardId();
    const local = varId();
    const sub = workflow({
      id: subId,
      kind: "sub",
      inputs: [{ name: "seed", type: "string" }],
      variables: [{ id: local, name: "rows", scope: "workflow", type: "array" }],
      nodes: [{ id: entry, type: "entry", name: "Entry" }, standard(body, [step(grow)])],
      edges: [edge(entry, "next", body)],
    });
    const first = cardId();
    const bot = linearBot([callCard(first, subId)], { workflows: [sub] });
    const s = scripted({
      [first]: () => outcome({ type: "call", workflowId: subId, inputs: { seed: "س".repeat(1_000) }, outputs: {} }),
      [grow]: () =>
        outcome(
          { type: "next" },
          { writes: [{ scope: "workflow", variableId: local, value: Array(70_000).fill("abc") }] },
        ),
    });
    const { result } = await run({ def: bot.def, executors: s.executors });
    expect(result.error?.fix).toBe(
      "Store ids instead of whole records. Largest variables: workflow.rows, workflow.seed.",
    );
  });
});

describe("limit failures skip the handlers", () => {
  test("step_limit_exceeded goes to the default even with an Error handler", async () => {
    const start = nodeId();
    const node = nodeId();
    const handler = nodeId();
    const handlerNode = nodeId();
    const handlerCard = cardId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        standard(
          node,
          Array.from({ length: 12 }, () => step()),
        ),
        { id: handler, type: "error_handler", name: "On error" },
        standard(handlerNode, [step(handlerCard)]),
      ],
      edges: [edge(start, "next", node), edge(handler, "next", handlerNode)],
    });
    const def = definition({ workflows: [main], settings: { limits: { stepsPerTurn: 10, turnSeconds: 120 } } });
    const s = scripted();
    const { result, commits } = await run({ def, executors: s.executors });
    expect(s.ran()).not.toContain(handlerCard);
    expect(failures(commits)).toMatchObject([{ code: "step_limit_exceeded", handledBy: "default" }]);
    expect(result.status).toBe("failed");
  });
});
