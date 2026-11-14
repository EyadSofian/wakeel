import { describe, expect, test } from "vitest";
import type { CodeOutcome } from "../../src/ports";
import {
  cardId,
  definition,
  edge,
  failures,
  harness,
  linearBot,
  nodeId,
  run,
  standard,
  state,
  texts,
  varId,
  wfId,
  workflow,
} from "../turn/harness";

/** The Code and Call workflow cards, and Exit node outputs (build plan 4.3). */

const success = (o: Partial<Extract<CodeOutcome, { ok: true }>> = {}): CodeOutcome => ({
  ok: true,
  value: null,
  patches: {},
  said: [],
  logs: [],
  ...o,
});
const failure = (o: Partial<Extract<CodeOutcome, { ok: false }>>): CodeOutcome => ({
  ok: false,
  code: "code_error",
  message: "boom",
  said: [],
  logs: [],
  ...o,
});

/** Main: Start → [Code card, Log card printing the variables], with the Code card's error port optional. */
function codeBot(options: { errorPort?: boolean; timeoutMs?: number } = {}) {
  const ids = { w: varId(), c: varId(), u: varId() };
  const codeCard = cardId();
  const start = nodeId();
  const node = nodeId();
  const recover = nodeId();
  const main = workflow({
    variables: [{ id: ids.w, name: "rows", scope: "workflow", type: "array" }],
    nodes: [
      { id: start, type: "start", name: "Start" },
      standard(node, [
        {
          id: codeCard,
          type: "code",
          source: "workflow.rows = []",
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        },
        { id: cardId(), type: "log", message: "after {{ turn.step }}" },
      ]),
      standard(recover, [{ id: cardId(), type: "log", message: "recovered" }]),
    ],
    edges: [edge(start, "next", node), ...(options.errorPort ? [edge(node, `card:${codeCard}:error`, recover)] : [])],
  });
  const def = definition({
    workflows: [main],
    variables: [
      { id: ids.c, name: "orderId", scope: "conversation", type: "string" },
      { id: ids.u, name: "points", scope: "user", type: "number" },
    ],
  });
  return {
    def: {
      ...def,
      manifest: {
        ...def.manifest,
        configVars: [
          { key: "API_KEY", secret: true },
          { key: "REGION", secret: false },
        ],
      },
    },
    ids,
  };
}
const logged = (commits: { logs: { message: string }[] }[]) => commits.flatMap((c) => c.logs.map((l) => l.message));

describe("code", () => {
  test("runs the card's source with the scopes, its limits and the step's idempotency key", async () => {
    const c = codeBot({ timeoutMs: 5_000 });
    const h = harness({ code: () => success() });
    const { input } = await run({ def: c.def, h, env: { API_KEY: "sk-test", REGION: "eg" } });
    expect(h.codeRuns).toHaveLength(1);
    expect(h.codeRuns[0]).toMatchObject({
      source: "workflow.rows = []",
      timeoutMs: 5_000,
      memoryMb: 64,
      idempotencyKey: `${input.turnId}:1`,
      secretKeys: ["API_KEY"],
    });
    expect(h.codeRuns[0]?.scopes.env).toEqual({ API_KEY: "sk-test", REGION: "eg" });
  });

  test("the time limit never runs past the turn's own", async () => {
    const c = codeBot({ timeoutMs: 60_000 });
    const h = harness({ code: () => success() });
    await run({ def: c.def, h, startedAt: h.clock.now() - 100_000 });
    expect(h.codeRuns[0]?.timeoutMs).toBe(20_000);
  });

  test("scope patches become variable writes, by name", async () => {
    const c = codeBot();
    const h = harness({
      code: () =>
        success({
          patches: {
            workflow: { set: { rows: [{ sku: "ORD-1" }] } },
            conversation: { unset: ["orderId"] },
            user: { set: { points: 120 } },
            turn: { set: { step: "تم" } },
          },
        }),
    });
    const { result, commits } = await run({
      def: c.def,
      h,
      state: state({ conversationVars: { [c.ids.c]: "ORD-0" } }),
    });
    expect(result.state.conversationVars).toEqual({ [c.ids.c]: null });
    expect(commits[0]?.user).toEqual({ vars: { [c.ids.u]: 120 } });
    expect(logged(commits)).toEqual(["after تم"]);
  });

  test("say() calls become messages, in order; log calls become log lines", async () => {
    const c = codeBot();
    const h = harness({
      code: () =>
        success({
          said: [
            { type: "text", text: "لقيت طلبك" },
            { type: "choice", text: "تأكيد؟", options: [{ label: "نعم", value: "y" }] },
          ],
          logs: [{ level: "warn", args: ["slow", { ms: 900 }] }],
        }),
    });
    const { commits } = await run({ def: c.def, h });
    expect(commits[0]?.messages).toEqual([
      { type: "text", text: "لقيت طلبك", format: "markdown" },
      { type: "choice", text: "تأكيد؟", options: [{ label: "نعم", value: "y" }] },
    ]);
    expect(commits[0]?.logs[0]).toEqual({ level: "warn", message: "slow", data: [{ ms: 900 }] });
  });

  test("a say() with an invalid message is message_invalid", async () => {
    const c = codeBot();
    const h = harness({ code: () => success({ said: [{ type: "text", text: "" }] }) });
    const { result } = await run({ def: c.def, h });
    expect(result.error?.code).toBe("message_invalid");
  });

  test.each([
    [
      { code: "code_error", message: "x is not defined", line: 3 },
      "Your code threw: x is not defined",
      "See line 3. The trace shows the variables at that point.",
    ],
    [
      { code: "code_syntax_error", message: "unexpected token", line: 1 },
      "Your code has a syntax error: unexpected token",
      "See line 1.",
    ],
    [
      { code: "code_timeout", message: "" },
      "Your code ran longer than 10000 ms",
      "Remove long loops, or raise the card's time limit (maximum 60 s).",
    ],
    [{ code: "code_memory_exceeded", message: "" }, "Your code used more than 64 MB", "Process less data at once."],
  ] as const)("a run that ends in %o fails with its code", async (outcome, message, fix) => {
    const c = codeBot();
    const h = harness({ code: () => failure(outcome) });
    const { result } = await run({ def: c.def, h });
    expect(result.error).toEqual({ code: outcome.code, message, fix });
  });

  test("a failure follows the card's error port, keeping what the code said first", async () => {
    const c = codeBot({ errorPort: true });
    const h = harness({ code: () => failure({ said: [{ type: "text", text: "لحظة..." }] }) });
    const { commits } = await run({ def: c.def, h });
    expect(texts(commits)).toEqual(["لحظة..."]);
    expect(logged(commits)).toEqual(["recovered"]);
    expect(failures(commits)).toMatchObject([{ code: "code_error", handledBy: "port" }]);
  });

  test("a sandbox that cannot be reached is internal_error through the error port", async () => {
    const c = codeBot({ errorPort: true });
    const h = harness({
      code: () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    const { commits } = await run({ def: c.def, h });
    expect(failures(commits)).toMatchObject([{ code: "internal_error", handledBy: "port" }]);
  });

  test.each([
    [{ conversation: { set: { nope: 1 } } }, "variable_not_found"],
    [{ workflow: { set: { orderId: "x" } } }, "variable_not_found"],
    [{ conversation: { set: { orderId: 5 } } }, "variable_type_mismatch"],
  ])("a patch %j fails with %s", async (patches, code) => {
    const c = codeBot();
    const h = harness({ code: () => success({ patches }) });
    const { result } = await run({ def: c.def, h });
    expect(result.error?.code).toBe(code);
  });
});

/** The Call workflow card in the linear bot's node, to change its inputs. */
function callCardOf(def: { workflows: { nodes: unknown[] }[] }) {
  const node = def.workflows[0]?.nodes[1] as { cards: { inputs: Record<string, string> }[] } | undefined;
  return node?.cards[0];
}

describe("call_workflow and Exit outputs", () => {
  /** Lookup(orderId: string, note?: string) → { status: string, eta: number } */
  function lookupBot(exitOutputs: Record<string, string> = { status: "workflow.orderId", eta: "env.ETA" }) {
    const subId = wfId();
    const entry = nodeId();
    const exit = nodeId();
    const sub = workflow({
      id: subId,
      kind: "sub",
      name: "Lookup",
      inputs: [
        { name: "orderId", type: "string" },
        { name: "note", type: "string", required: false },
      ],
      outputs: [
        { name: "status", type: "string" },
        { name: "eta", type: "number" },
      ],
      nodes: [
        { id: entry, type: "entry", name: "Entry" },
        { id: exit, type: "exit", name: "Done", outputs: exitOutputs },
      ],
      edges: [edge(entry, "next", exit)],
    });
    const status = varId();
    const eta = varId();
    const call = cardId();
    const bot = linearBot(
      [
        {
          id: call,
          type: "call_workflow",
          workflowId: subId,
          inputs: { orderId: "event.text" },
          outputs: { status, eta },
        },
        { id: cardId(), type: "log", message: "{{ conversation.status }} / {{ conversation.eta }}" },
      ],
      {
        workflows: [sub],
        variables: [
          { id: status, name: "status", scope: "conversation", type: "string" },
          { id: eta, name: "eta", scope: "conversation", type: "number" },
        ],
      },
    );
    return { ...bot, status, eta, subId };
  }

  test("inputs go in and outputs come back to the caller's variables", async () => {
    const b = lookupBot();
    const { result, commits } = await run({ def: b.def, env: { ETA: 3 } });
    expect(logged(commits)).toEqual(["مرحبا / 3"]);
    expect(result.state).toMatchObject({
      status: "idle",
      stack: [],
      conversationVars: { [b.status]: "مرحبا", [b.eta]: 3 },
    });
  });

  test("an input expression that fails is expression_error at the call card", async () => {
    const b = lookupBot();
    const def = structuredClone(b.def);
    const card = callCardOf(def);
    if (card) card.inputs = { orderId: "env.X.y" };
    const { result } = await run({ def });
    expect(result.error?.code).toBe("expression_error");
  });

  test("an input that evaluates to undefined counts as missing", async () => {
    const b = lookupBot();
    const def = structuredClone(b.def);
    const card = callCardOf(def);
    if (card) card.inputs = { orderId: "env.NOTHING" };
    const { result } = await run({ def });
    expect(result.error?.code).toBe("workflow_input_missing");
  });

  test("an Exit output of the wrong type for the caller's variable is variable_type_mismatch", async () => {
    const b = lookupBot({ status: "workflow.orderId", eta: "workflow.orderId" });
    const { result } = await run({ def: b.def });
    expect(result.error?.code).toBe("variable_type_mismatch");
  });
});
