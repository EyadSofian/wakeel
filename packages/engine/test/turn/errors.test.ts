import { AppError, newElementId } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  capture,
  cardId,
  code,
  definition,
  edge,
  events,
  failures,
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
 * Architecture §4.4 "Errors": `fail(error)` resolves in order: the card's failure port → the
 * workflow's Error handler node → the bot's error workflow → the default.
 */

const BOOM = { code: "code_error", message: "Your code threw: boom", fix: "See line 3." };

/**
 * Main: Start → `work` (a Code card `failing`, then `after`). Options add each level of handling:
 * the Code card's error port, the workflow's Error handler, the bot's error workflow.
 */
function errorBot(levels: { port?: boolean; handler?: boolean; errorWorkflow?: boolean }) {
  const start = nodeId();
  const work = nodeId();
  const failing = cardId();
  const after = cardId();
  const recover = nodeId();
  const recoverCard = cardId();
  const handler = nodeId();
  const handlerNode = nodeId();
  const handlerCard = cardId();
  const main = workflow({
    nodes: [
      { id: start, type: "start", name: "Start" },
      standard(work, [code(failing), step(after)], "Work"),
      standard(recover, [step(recoverCard)], "Recover"),
      ...(levels.handler
        ? [{ id: handler, type: "error_handler", name: "On error" }, standard(handlerNode, [step(handlerCard)])]
        : []),
    ],
    edges: [
      edge(start, "next", work),
      ...(levels.port ? [edge(work, `card:${failing}:error`, recover)] : []),
      ...(levels.handler ? [edge(handler, "next", handlerNode)] : []),
    ],
  });
  const errorWfId = wfId();
  const ewHandler = nodeId();
  const ewNode = nodeId();
  const ewCard = cardId();
  const errorWf = workflow({
    id: errorWfId,
    kind: "error",
    name: "Errors",
    nodes: [{ id: ewHandler, type: "error_handler", name: "On error" }, standard(ewNode, [step(ewCard)])],
    edges: [edge(ewHandler, "next", ewNode)],
  });
  const def = definition({
    workflows: levels.errorWorkflow ? [main, errorWf] : [main],
    ...(levels.errorWorkflow ? { errorWorkflowId: errorWfId } : {}),
  });
  return { def, failing, after, recoverCard, handlerCard, ewCard, work };
}

describe("resolution order", () => {
  test("1. the card's own error port, when connected", async () => {
    const b = errorBot({ port: true, handler: true, errorWorkflow: true });
    const s = scripted({ [b.failing]: () => outcome({ type: "fail", error: BOOM }) });
    const { result, commits } = await run({ def: b.def, executors: s.executors });
    expect(s.ran()).toEqual([b.failing, b.recoverCard]);
    expect(failures(commits)).toEqual([
      {
        ...BOOM,
        location: { workflowId: b.def.manifest.mainWorkflowId, nodeId: b.work, cardId: b.failing },
        handledBy: "port",
      },
    ]);
    expect(result).toMatchObject({ status: "completed" });
    expect(result.error).toBeUndefined();
  });

  test("2. the workflow's Error handler node", async () => {
    const b = errorBot({ handler: true, errorWorkflow: true });
    const s = scripted({ [b.failing]: () => outcome({ type: "fail", error: BOOM }) });
    const { result, commits } = await run({ def: b.def, executors: s.executors });
    expect(s.ran()).toEqual([b.failing, b.handlerCard]);
    expect(failures(commits).map((f) => f.handledBy)).toEqual(["error_handler"]);
    expect(result.status).toBe("completed");
  });

  test("3. the bot's error workflow", async () => {
    const b = errorBot({ errorWorkflow: true });
    const s = scripted({ [b.failing]: () => outcome({ type: "fail", error: BOOM }) });
    const { result, commits } = await run({ def: b.def, executors: s.executors });
    expect(s.ran()).toEqual([b.failing, b.ewCard]);
    expect(failures(commits).map((f) => f.handledBy)).toEqual(["error_workflow"]);
    expect(result).toMatchObject({ status: "completed", state: state() });
  });

  test("4. the default: error message, error event, stack cleared", async () => {
    const b = errorBot({});
    const s = scripted({ [b.failing]: () => outcome({ type: "fail", error: BOOM }) });
    const { result, commits } = await run({ def: b.def, executors: s.executors });
    expect(s.ran()).toEqual([b.failing]);
    expect(texts(commits)).toEqual(["Something went wrong on our side. Please try again in a moment."]);
    expect(events(commits)).toEqual([
      { type: "error", data: { code: "code_error", message: "Your code threw: boom", retryable: false } },
    ]);
    expect(result).toMatchObject({ status: "failed", error: BOOM, state: state() });
  });

  test("the default error message is the bot's own, filled in", async () => {
    const name = varId();
    const bot = linearBot([code("card_FAILFAILFA")], {
      settings: { errorMessage: "عذراً يا {{ user.name }}، حصلت مشكلة" },
      variables: [{ id: name, name: "name", scope: "user", type: "string" }],
    });
    const s = scripted({ card_FAILFAILFA: () => outcome({ type: "fail", error: BOOM }) });
    const { commits } = await run({
      def: bot.def,
      executors: s.executors,
      user: { vars: { [name]: "منى" }, attributes: {} },
    });
    expect(texts(commits)).toEqual(["عذراً يا منى، حصلت مشكلة"]);
  });

  test("a bot error message that cannot be filled in falls back to the platform's", async () => {
    const bot = linearBot([code("card_FAILFAILFA")], { settings: { errorMessage: "{{ user.name.trim() }}" } });
    const s = scripted({ card_FAILFAILFA: () => outcome({ type: "fail", error: BOOM }) });
    const { commits } = await run({ def: bot.def, executors: s.executors });
    expect(texts(commits)).toEqual(["Something went wrong on our side. Please try again in a moment."]);
  });

  test("retryable codes say so in the error event", async () => {
    const bot = linearBot([code("card_FAILFAILFA")]);
    const s = scripted({
      card_FAILFAILFA: () => outcome({ type: "fail", error: { code: "model_unavailable", message: "m", fix: "f" } }),
    });
    const { commits } = await run({ def: bot.def, executors: s.executors });
    expect(events(commits)).toMatchObject([{ type: "error", data: { retryable: true } }]);
  });
});

describe("handlers that fail", () => {
  test("a failure inside the Error handler's path goes to the default, not back to the handler", async () => {
    const b = errorBot({ handler: true, errorWorkflow: true });
    const s = scripted({
      [b.failing]: () => outcome({ type: "fail", error: BOOM }),
      [b.handlerCard]: () => outcome({ type: "fail", error: { ...BOOM, message: "again" } }),
    });
    const { result, commits } = await run({ def: b.def, executors: s.executors });
    expect(s.ran()).toEqual([b.failing, b.handlerCard]);
    expect(failures(commits).map((f) => f.handledBy)).toEqual(["error_handler", "default"]);
    expect(result.error?.message).toBe("again");
  });

  test("a failure inside the error workflow goes to the default", async () => {
    const b = errorBot({ errorWorkflow: true });
    const s = scripted({
      [b.failing]: () => outcome({ type: "fail", error: BOOM }),
      [b.ewCard]: () => outcome({ type: "fail", error: BOOM }),
    });
    const { commits } = await run({ def: b.def, executors: s.executors });
    expect(failures(commits).map((f) => f.handledBy)).toEqual(["error_workflow", "default"]);
  });

  test("an error workflow without an Error handler node is skipped", async () => {
    const b = errorBot({ errorWorkflow: true });
    const def = {
      ...b.def,
      workflows: b.def.workflows.map((w) => (w.kind === "error" ? { ...w, nodes: [], edges: [] } : w)),
    };
    const s = scripted({ [b.failing]: () => outcome({ type: "fail", error: BOOM }) });
    const { commits } = await run({ def, executors: s.executors });
    expect(failures(commits).map((f) => f.handledBy)).toEqual(["default"]);
  });
});

describe("failure ports", () => {
  test("a Capture card's failure leaves through its failed port", async () => {
    const ask = cardId();
    const into = varId();
    const start = nodeId();
    const node = nodeId();
    const fallback = nodeId();
    const fallbackCard = cardId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        standard(node, [capture(ask, into)]),
        standard(fallback, [step(fallbackCard)]),
      ],
      edges: [edge(start, "next", node), edge(node, `card:${ask}:failed`, fallback)],
    });
    const s = scripted({
      [ask]: () => outcome({ type: "fail", error: { code: "validation_failed", message: "no", fix: "f" } }),
    });
    await run({ def: definition({ workflows: [main] }), executors: s.executors });
    expect(s.ran()).toEqual([ask, fallbackCard]);
  });

  test("an autonomous node's failure leaves through its error port", async () => {
    const start = nodeId();
    const agent = nodeId();
    const fallback = nodeId();
    const fallbackCard = cardId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        { id: agent, type: "autonomous", name: "Agent", instructions: "ساعد" },
        standard(fallback, [step(fallbackCard)]),
      ],
      edges: [edge(start, "next", agent), edge(agent, "error", fallback)],
    });
    const h = harness({
      autonomy: () => {
        throw new AppError("autonomy_loop_exceeded", { node: "Agent", limit: 6 });
      },
    });
    const s = scripted();
    const { commits } = await run({ def: definition({ workflows: [main] }), h, executors: s.executors });
    expect(s.ran()).toEqual([fallbackCard]);
    expect(failures(commits)).toMatchObject([{ code: "autonomy_loop_exceeded", handledBy: "port" }]);
  });
});

describe("what counts as a failure", () => {
  test("an executor that throws an AppError fails with its code and fix", async () => {
    const bot = linearBot([code("card_FAILFAILFA")]);
    const s = scripted({
      card_FAILFAILFA: () => {
        throw new AppError("code_timeout", { limit: 10_000 });
      },
    });
    const { result } = await run({ def: bot.def, executors: s.executors });
    expect(result.error).toEqual({
      code: "code_timeout",
      message: "Your code ran longer than 10000 ms",
      fix: "Remove long loops, or raise the card's time limit (maximum 60 s).",
    });
  });

  test("anything else thrown is internal_error, with the turn id for support", async () => {
    const bot = linearBot([code("card_FAILFAILFA")]);
    const s = scripted({
      card_FAILFAILFA: () => {
        throw new TypeError("x is undefined");
      },
    });
    const { result, input } = await run({ def: bot.def, executors: s.executors });
    expect(result.error?.code).toBe("internal_error");
    expect(result.error?.message).toBe("Something went wrong on our side: TypeError: x is undefined");
    expect(result.error?.fix).toContain(input.turnId);
  });

  test("an outcome that does not match the contract is internal_error", async () => {
    const bot = linearBot([code("card_FAILFAILFA")]);
    const s = scripted({ card_FAILFAILFA: () => ({ outcome: { type: "jump" } as never }) });
    const { result } = await run({ def: bot.def, executors: s.executors });
    expect(result.error?.code).toBe("internal_error");
    expect(result.error?.message).toMatch(/outcome the engine does not understand/);
  });

  test("a card type with no executor is internal_error", async () => {
    const bot = linearBot([step()]);
    const { result } = await run({ def: bot.def, executors: {} });
    expect(result.error?.message).toBe("Something went wrong on our side: No executor for log cards.");
  });

  test("the engine's own executors are used by default", async () => {
    const branches = [{ id: newElementId("br"), label: "Upset", description: "العميل زعلان" }];
    const bot = linearBot([step(), { id: cardId(), type: "ai_branch", branches }]);
    const { result, commits } = await run({ def: bot.def });
    // The Log card has an executor (4.3); the AI branch card does not have one until Phase 6.
    expect(commits.flatMap((c) => c.logs)).toEqual([{ level: "info", message: "step" }]);
    expect(result.error?.message).toBe("Something went wrong on our side: No executor for ai_branch cards.");
  });

  test("an autonomous node with no autonomy port is internal_error", async () => {
    const start = nodeId();
    const agent = nodeId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        { id: agent, type: "autonomous", name: "Agent", instructions: "ساعد" },
      ],
      edges: [edge(start, "next", agent)],
    });
    const { result } = await run({ def: definition({ workflows: [main] }) });
    expect(result.error?.message).toBe("Something went wrong on our side: Autonomous nodes are not available.");
  });

  test("a Main workflow without a Start node is not_found", async () => {
    const main = workflow({ nodes: [] });
    const { result } = await run({ def: definition({ workflows: [main] }) });
    expect(result.error?.code).toBe("not_found");
  });

  test("a stack frame pointing at a node the definition no longer has is not_found", async () => {
    const bot = linearBot([step()]);
    const ghost = state({
      stack: [{ workflowId: bot.main.id, nodeId: "node_GHOSTGHOST", cardIndex: 0, vars: {}, inputs: {} }],
    });
    const { result } = await run({ def: bot.def, state: ghost, committedSteps: 1 });
    expect(result.error?.code).toBe("not_found");
  });

  test("an edge into a Note is no_route", async () => {
    const start = nodeId();
    const note = nodeId();
    const main = workflow({
      nodes: [
        { id: start, type: "start", name: "Start" },
        { id: note, type: "note", name: "Read me" },
      ],
      edges: [edge(start, "next", note)],
    });
    const { result } = await run({ def: definition({ workflows: [main] }) });
    expect(result.error?.message).toBe('"Read me" has nowhere to go next');
  });
});

describe("variable writes", () => {
  function writeBot() {
    const a = cardId();
    const n = varId();
    const brand = varId();
    const tier = varId();
    const bot = linearBot([step(a)], {
      variables: [
        { id: n, name: "count", scope: "conversation", type: "number" },
        { id: brand, name: "brand", scope: "bot", type: "string" },
        { id: tier, name: "tier", scope: "user", type: "enum", enumValues: ["basic", "gold"] },
      ],
    });
    return { ...bot, a, n, brand, tier };
  }

  test("a value of the wrong type is variable_type_mismatch and nothing from the step is kept", async () => {
    const w = writeBot();
    const s = scripted({
      [w.a]: () => ({
        ...say("لن تُرسل"),
        writes: [
          { scope: "user", variableId: w.tier, value: "gold" },
          { scope: "conversation", variableId: w.n, value: "three" },
        ],
      }),
    });
    const { result, commits } = await run({ def: w.def, executors: s.executors });
    expect(result.error?.message).toBe('"count" expects number but received string');
    expect(texts(commits)).toEqual(["Something went wrong on our side. Please try again in a moment."]);
    expect(commits.some((c) => c.user)).toBe(false);
  });

  test("an unknown variable, or a scope that does not match, is variable_not_found", async () => {
    const w = writeBot();
    for (const write of [
      { scope: "conversation" as const, variableId: "var_NOSUCHVAR0", value: 1 },
      { scope: "user" as const, variableId: w.n, value: 1 },
      { scope: "workflow" as const, variableId: w.n, value: 1 },
    ]) {
      const s = scripted({ [w.a]: () => ({ outcome: { type: "next" }, writes: [write] }) });
      const { result } = await run({ def: w.def, executors: s.executors });
      expect(result.error?.code).toBe("variable_not_found");
    }
  });

  test("an enum value outside its list is variable_type_mismatch", async () => {
    const w = writeBot();
    const s = scripted({
      [w.a]: () => ({ outcome: { type: "next" }, writes: [{ scope: "user", variableId: w.tier, value: "platinum" }] }),
    });
    const { result } = await run({ def: w.def, executors: s.executors });
    expect(result.error?.code).toBe("variable_type_mismatch");
  });

  test("valid writes commit, user variables included", async () => {
    const w = writeBot();
    const s = scripted({
      [w.a]: () => ({
        outcome: { type: "next" },
        writes: [
          { scope: "user", variableId: w.tier, value: "gold" },
          { scope: "conversation", variableId: w.n, value: 3 },
        ],
      }),
    });
    const { result, commits } = await run({
      def: w.def,
      executors: s.executors,
      event: message("كام نقطة عندي؟"),
      user: { vars: { var_OTHERVAR00: true }, attributes: {} },
    });
    expect(result.state.conversationVars).toEqual({ [w.n]: 3 });
    expect(commits[0]?.user).toEqual({ vars: { var_OTHERVAR00: true, [w.tier]: "gold" } });
  });
});
