import { AppError, AutonomousNode, type AutonomyMemory, type BotDefinition } from "@wakeel/contracts";
import { FakeLlm, makeBotDefinition } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { type AutonomyStepInput, createAutonomy, type RunOutcome } from "../../src/engine";

/**
 * Task 6.5 (architecture §6.3): one iteration of the Autonomous Node, with the fake LLM and a
 * scripted sandbox. Acceptance: every branch of the loop; a rejected write is fed back and not applied.
 */

const NAME = "var_CustName00";
const ORDER = "var_OrderNo000";
const TIER = "var_TierLevel0";
const SECRET = "var_Internal00";
/** One writable variable of each remaining type, for the type checks. */
const TYPED = [
  ["var_TypeNumber", "number"],
  ["var_TypeBool00", "boolean"],
  ["var_TypeDate00", "date"],
  ["var_TypeObject", "object"],
  ["var_TypeArray0", "array"],
  ["var_TypeAny000", "any"],
] as const;
const base = makeBotDefinition({ name: "مساعد النور" });
const definition = {
  ...base,
  manifest: {
    ...base.manifest,
    variables: [
      { id: NAME, name: "name", scope: "user", type: "string", sensitive: false },
      { id: ORDER, name: "orderNumber", scope: "conversation", type: "string", sensitive: false },
      { id: TIER, name: "tier", scope: "conversation", type: "enum", enumValues: ["gold", "silver"], sensitive: false },
      { id: SECRET, name: "internalNote", scope: "conversation", type: "string", sensitive: false },
      ...TYPED.map(([id, type]) => ({ id, name: `t_${type}`, scope: "conversation", type, sensitive: false })),
    ],
  },
} as unknown as BotDefinition;

const node = AutonomousNode.parse({
  id: "node_Assistant0",
  type: "autonomous",
  name: "Assistant",
  instructions: "Help with orders.",
  variableAccess: [
    { variableId: NAME, mode: "read" },
    { variableId: ORDER, mode: "write" },
    { variableId: TIER, mode: "write" },
    ...TYPED.map(([variableId]) => ({ variableId, mode: "write" as const })),
  ],
  exits: [
    {
      id: "exit_Escalate00",
      name: "escalate",
      description: "Refund over the limit.",
      schema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    },
  ],
  allowHandoff: true,
  maxIterations: 3,
});

const M = ":::";

function setup(replies: string[], runs: RunOutcome[] = []) {
  const llm = new FakeLlm();
  for (const r of replies) llm.scriptText(r);
  const codeCalls: { source: string; scopes: Record<string, unknown> }[] = [];
  const autonomy = createAutonomy({
    model: () => ({ stream: (r) => llm.stream({ model: "fake", ...r }) }),
    code: {
      run: async (req) => {
        codeCalls.push(req);
        const next = runs.shift();
        if (!next) throw new Error("no scripted run");
        return next;
      },
    },
    context: async () => ({
      definition,
      bot: { name: "مساعد النور" },
      env: {},
      transcript: [{ direction: "in", payload: { type: "text", text: "طلبي 5678 فين؟" } }],
      now: "2026-11-14T10:00:00.000Z",
    }),
  });
  const input = (memory?: AutonomyMemory, extra: Partial<AutonomyStepInput> = {}): AutonomyStepInput => ({
    node,
    location: { workflowId: definition.manifest.mainWorkflowId, nodeId: node.id },
    memory,
    scopes: { user: { name: "منى" }, conversation: {}, workflow: {}, turn: {} },
    turnId: "turn_01m7a256m0a13warwhczsjhx9b",
    stepSeq: 3,
    idempotencyKey: "turn_x:3",
    deadline: Date.parse("2026-11-14T10:02:00.000Z"),
    ...extra,
  });
  const lastPrompt = () => {
    const call = llm.calls.at(-1)?.request as { system: string; messages: { content: string }[] };
    return call.messages.map((m) => m.content).join("\n");
  };
  return { autonomy, input, codeCalls, lastPrompt, llm };
}

describe("one iteration", () => {
  test("say and listen: the messages go out and the node waits for the user", async () => {
    const s = setup([`${M}say text\nأهلاً يا منى، رقم الطلب كام؟\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.messages).toEqual([{ type: "text", text: "أهلاً يا منى، رقم الطلب كام؟", format: "markdown" }]);
    expect(r.outcome).toEqual({
      type: "wait",
      wait: { kind: "listen", nodeId: node.id, since: "2026-11-14T10:00:00.000Z" },
    });
    expect(r.memory).toMatchObject({ iteration: 0, feedback: [] });
    expect(s.lastPrompt()).toContain('user.name (read only) = "منى"');
  });

  test("a run that returns a value iterates with the value as feedback; an exit in the same reply is ignored", async () => {
    const s = setup(
      [`${M}run\nreturn await tools.lookupOrder({ orderNumber: "5678" })\n${M}exit escalate {"amount": 10}\n${M}end`],
      [{ ok: true, returned: true, value: { status: "shipped" }, patches: {} }],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "next" });
    expect(r.exit).toBeUndefined();
    expect(r.memory).toMatchObject({ iteration: 1, feedback: [{ kind: "run_result", text: '{"status":"shipped"}' }] });
    expect(s.codeCalls[0]?.source).toBe('return await tools.lookupOrder({ orderNumber: "5678" })');
  });

  test("a run without return followed by an exit leaves through it, with its data and the accepted writes", async () => {
    const s = setup(
      [`${M}run\nconversation.orderNumber = "5678"\n${M}exit escalate {"amount": 2500}\n${M}end`],
      [{ ok: true, returned: false, patches: { conversation: { set: { orderNumber: "5678" } } } }],
    );
    const r = await s.autonomy.step(s.input({ iteration: 2, memo: {}, feedback: [] }));
    expect(r.outcome).toEqual({ type: "goto", port: "exit:exit_Escalate00" });
    expect(r.exit).toEqual({ name: "escalate", data: { amount: 2500 } });
    expect(r.writes).toEqual([{ scope: "conversation", variableId: ORDER, value: "5678" }]);
    expect(r.memory.iteration).toBe(0);
  });

  test("a rejected write is explained to the model and not applied; the accepted one is", async () => {
    const s = setup(
      [
        `${M}run\nuser.name = "x"; conversation.tier = "platinum"; conversation.internalNote = "y"; conversation.orderNumber = 5678; conversation.orderNumber = "5678"\n${M}end`,
      ],
      [
        {
          ok: true,
          returned: false,
          patches: {
            user: { set: { name: "حد تاني" } },
            conversation: { set: { tier: "platinum", internalNote: "y", orderNumber: "5678" } },
          },
        },
      ],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.writes).toEqual([{ scope: "conversation", variableId: ORDER, value: "5678" }]);
    expect(r.outcome).toEqual({ type: "next" });
    const fb = r.memory.feedback.find((f) => f.kind === "write_rejected")?.text ?? "";
    expect(fb).toContain("user.name was not changed: it is read only here.");
    expect(fb).toContain(
      'conversation.tier was not changed: it must be one of "gold", "silver", not string "platinum".',
    );
    expect(fb).toContain("conversation.internalNote was not changed: this node has no access to it.");
  });

  test("a wrongly typed write is rejected even when access allows it", async () => {
    const s = setup(
      [`${M}run\nconversation.orderNumber = 5678\n${M}end`],
      [{ ok: true, returned: false, patches: { conversation: { set: { orderNumber: 5678 } } } }],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.writes).toBeUndefined();
    expect(r.memory.feedback[0]?.text).toBe(
      "conversation.orderNumber was not changed: it must be a string, not number 5678.",
    );
  });

  test("code that throws is fed back with its line, and nothing it changed is kept", async () => {
    const s = setup(
      [`${M}run\nthrow new Error("boom")\n${M}end`],
      [{ ok: false, error: { message: "boom", line: 1 } }],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "next" });
    expect(r.writes).toBeUndefined();
    expect(r.memory.feedback).toEqual([
      { kind: "run_error", text: "Your code failed on line 1: boom. Nothing it changed was kept." },
    ]);
  });

  test("an invalid exit is fed back as exit_invalid; messages already sent are mentioned", async () => {
    const s = setup([`${M}say text\nلحظة\n${M}exit escalate {"amount": "كتير"}\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "next" });
    expect(r.messages).toHaveLength(1);
    expect(r.memory.feedback[0]?.kind).toBe("exit_invalid");
    expect(r.memory.feedback[0]?.text).toContain("1 message from that reply was already sent");
  });

  test("the handoff exit hands the conversation over with its reason", async () => {
    const s = setup([`${M}say text\nهحولك لزميل\n${M}exit handoff {"reason": "refund dispute"}\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({ type: "handoff", reason: "refund dispute", summary: "", variables: {} });
  });

  test("a reply with no directives is recovered as a message and listen, and flagged", async () => {
    const s = setup(["طلبك اتشحن امبارح."]);
    const r = await s.autonomy.step(s.input());
    expect(r.messages?.[0]).toMatchObject({ type: "text", text: "طلبك اتشحن امبارح." });
    expect(r.outcome).toMatchObject({ type: "wait" });
    expect(r.logs).toEqual([{ level: "warn", message: "protocol_recovered: the reply had no directives" }]);
  });
});

describe("across iterations", () => {
  test("feedback from the previous iteration is shown once, then cleared", async () => {
    const s = setup([`${M}say text\nتمام\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(
      s.input({ iteration: 1, memo: {}, feedback: [{ kind: "run_result", text: '{"status":"shipped"}' }] }),
    );
    expect(s.lastPrompt()).toContain('<data source="feedback:run_result">\n{"status":"shipped"}');
    expect(r.memory.feedback).toEqual([]);
  });

  test("the iteration limit fails the node with autonomy_loop_exceeded", async () => {
    const s = setup([]);
    await expect(s.autonomy.step(s.input({ iteration: 3, memo: {}, feedback: [] }))).rejects.toMatchObject({
      code: "autonomy_loop_exceeded",
    });
    expect(AppError).toBeDefined();
  });

  test("a user's reply after listen starts a fresh budget", async () => {
    const s = setup([`${M}say text\nتمام\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(
      s.input({ iteration: 3, memo: {}, feedback: [] }, { resume: { kind: "message", event: { text: "5678" } } }),
    );
    expect(r.outcome).toMatchObject({ type: "wait" });
  });

  test("memo and turn are the node's scratch space; an oversized memo is refused", async () => {
    const s = setup(
      [`${M}run\nmemo.step = 2; turn.lookups = 1\n${M}end`, `${M}run\nmemo.blob = big\n${M}end`],
      [
        { ok: true, returned: false, patches: { memo: { set: { step: 2 } }, turn: { set: { lookups: 1 } } } },
        { ok: true, returned: false, patches: { memo: { set: { blob: "x".repeat(20_000) } } } },
      ],
    );
    const first = await s.autonomy.step(s.input());
    expect(first.memory.memo).toEqual({ step: 2 });
    expect(first.turn).toEqual({ lookups: 1 });
    expect(s.codeCalls[0]?.scopes["memo"]).toEqual({});
    const second = await s.autonomy.step(s.input(first.memory));
    expect(second.memory.memo).toEqual({ step: 2 });
    expect(second.memory.feedback[0]?.text).toBe("memo was not changed: it would be over 16 KB.");
  });
});

describe("suspending tools (architecture §6.3, ADR-035)", () => {
  const pending = {
    toolId: "tool_AskAddr000",
    name: "askAddress",
    workflowId: "wf_AskAddres0",
    input: { reason: "delivery" },
    toolCallId: "turn_x:3:run:askAddress",
  };
  const pendingTool = {
    toolId: pending.toolId,
    toolCallId: pending.toolCallId,
    name: pending.name,
    input: pending.input,
  };
  const after = "Code after that call did not run, and the variables it set were not kept.";

  test("a workflow tool ends the run at the call: the node calls the workflow and keeps the call pending", async () => {
    const s = setup(
      [
        `${M}say text\nهسألك عن العنوان\n${M}run\nconversation.orderNumber = "5678"\nawait tools.askAddress({ reason: "delivery" })\n${M}end`,
      ],
      [{ ok: false, suspended: pending }],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({
      type: "call",
      workflowId: "wf_AskAddres0",
      inputs: { reason: "delivery" },
      outputs: {},
      toolCallId: "turn_x:3:run:askAddress",
    });
    expect(r.messages).toEqual([{ type: "text", text: "هسألك عن العنوان", format: "markdown" }]);
    expect(r.writes).toBeUndefined();
    expect(r.memory.pendingTool).toEqual(pendingTool);
    // The budget continues: an inline workflow called in every iteration still hits maxIterations.
    expect(r.memory.iteration).toBe(1);
  });

  test("when the workflow returns, the next iteration reads its outputs and that the rest did not run", async () => {
    const s = setup([`${M}say text\nهنوصله على ١٢ شارع التحرير\n${M}exit listen\n${M}end`]);
    // What the engine writes when the called frame returns (turn.ts #return).
    const raw = JSON.stringify({ toolCallId: pending.toolCallId, outputs: { address: "١٢ شارع التحرير" } });
    const r = await s.autonomy.step(
      s.input({ iteration: 1, memo: {}, feedback: [{ kind: "tool_resumed", text: raw }], pendingTool }),
    );
    expect(s.lastPrompt()).toContain(`Tool askAddress finished with {"address":"١٢ شارع التحرير"}. ${after}`);
    expect(r.memory.pendingTool).toBeUndefined();
    expect(r.memory.feedback).toEqual([]);
  });

  test("a submitted tool result resumes the node with a fresh budget", async () => {
    const s = setup([`${M}say text\nتم الدفع\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(
      s.input(
        { iteration: 3, memo: {}, feedback: [], pendingTool },
        {
          resume: {
            kind: "tool_result",
            toolCallId: pending.toolCallId,
            event: { kind: "tool_result", payload: { toolCallId: pending.toolCallId, result: { paid: true } } },
          },
        },
      ),
    );
    expect(s.lastPrompt()).toContain(`Tool askAddress finished with {"paid":true}. ${after}`);
    expect(r.outcome).toMatchObject({ type: "wait" });
    expect(r.memory.pendingTool).toBeUndefined();
  });

  test("a submitted error is fed back as a failure", async () => {
    const s = setup([`${M}say text\nالدفع ما تمش\n${M}exit listen\n${M}end`]);
    await s.autonomy.step(
      s.input(
        { iteration: 1, memo: {}, feedback: [], pendingTool },
        {
          resume: {
            kind: "tool_result",
            toolCallId: pending.toolCallId,
            event: {
              kind: "tool_result",
              payload: { toolCallId: pending.toolCallId, error: { message: "card declined" } },
            },
          },
        },
      ),
    );
    expect(s.lastPrompt()).toContain(`Tool askAddress failed: card declined. ${after}`);
  });

  test("a result for a call that is not pending is ignored", async () => {
    const s = setup([`${M}say text\nلسه مستني\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(
      s.input(
        { iteration: 1, memo: {}, feedback: [], pendingTool },
        {
          resume: { kind: "tool_result", toolCallId: "other", event: { kind: "tool_result", payload: { result: 1 } } },
        },
      ),
    );
    expect(s.lastPrompt()).not.toContain("finished with");
    expect(r.memory.pendingTool).toEqual(pendingTool);
  });

  test("a tool that waits for an outside result makes the node wait for it", async () => {
    const external = {
      toolId: "tool_Pay0000000",
      name: "charge",
      input: { amount: 10 },
      toolCallId: "turn_x:3:run:charge",
      reason: "waiting for the payment page",
    };
    const s = setup([`${M}run\nawait tools.charge({ amount: 10 })\n${M}end`], [{ ok: false, suspended: external }]);
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toEqual({
      type: "wait",
      wait: {
        kind: "tool",
        nodeId: node.id,
        toolId: "tool_Pay0000000",
        toolCallId: "turn_x:3:run:charge",
        reason: "waiting for the payment page",
        since: "2026-11-14T10:00:00.000Z",
      },
    });
    expect(r.memory.pendingTool?.toolCallId).toBe("turn_x:3:run:charge");
  });
});

describe("citations (architecture §6.5)", () => {
  test("citation tokens never reach the user", async () => {
    const s = setup([`${M}say text\nالشحن بياخد ٣ أيام [[c1]].\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.messages).toEqual([{ type: "text", text: "الشحن بياخد ٣ أيام.", format: "markdown" }]);
  });
});

describe("write types", () => {
  test.each([
    ["number", 3, "x"],
    ["boolean", true, "yes"],
    ["date", "2026-11-14", "next week"],
    ["object", { a: 1 }, [1]],
    ["array", [1, 2], { a: 1 }],
    ["any", null, undefined],
  ] as const)("a %s accepts %j and refuses %j", async (type, good, bad) => {
    const name = `t_${type}`;
    const set: Record<string, unknown> = { [name]: good };
    const s = setup(
      [`${M}run\nx\n${M}end`, `${M}run\nx\n${M}end`],
      [
        { ok: true, returned: false, patches: { conversation: { set } } } as RunOutcome,
        { ok: true, returned: false, patches: { conversation: { set: { [name]: bad ?? null } } } } as RunOutcome,
      ],
    );
    const first = await s.autonomy.step(s.input());
    expect(first.writes).toHaveLength(1);
    const second = await s.autonomy.step(s.input());
    if (type === "any") expect(second.writes).toHaveLength(1);
    else expect(second.memory.feedback[0]?.text).toContain(`it must be a ${type}`);
  });
});

describe("resume edge cases", () => {
  const pendingTool = { toolId: "tool_AskAddr000", toolCallId: "k:askAddress", name: "askAddress", input: {} };
  const reply = `${M}say text\nتمام\n${M}exit listen\n${M}end`;

  test("feedback that is not the engine's record, or is for another call, is left as it is", async () => {
    const s = setup([reply]);
    const r = await s.autonomy.step(
      s.input({
        iteration: 1,
        memo: {},
        feedback: [
          { kind: "run_result", text: "1" },
          { kind: "tool_resumed", text: "not json" },
          { kind: "tool_resumed", text: JSON.stringify({ toolCallId: "other", outputs: {} }) },
        ],
        pendingTool,
      }),
    );
    expect(s.lastPrompt()).toContain("not json");
    expect(r.memory.pendingTool).toEqual(pendingTool);
  });

  test("a workflow that returned no outputs, and a submitted error without a message", async () => {
    const s = setup([reply, reply]);
    await s.autonomy.step(
      s.input({
        iteration: 1,
        memo: {},
        feedback: [{ kind: "tool_resumed", text: JSON.stringify({ toolCallId: "k:askAddress" }) }],
        pendingTool,
      }),
    );
    expect(s.lastPrompt()).toContain("Tool askAddress finished with {}.");
    await s.autonomy.step(
      s.input(
        { iteration: 1, memo: {}, feedback: [], pendingTool },
        { resume: { kind: "tool_result", toolCallId: "k:askAddress", event: { payload: { error: {} } } } },
      ),
    );
    expect(s.lastPrompt()).toContain("Tool askAddress failed: the tool reported an error.");
  });

  test("a submitted result with no value reads as null; with nothing pending, nothing happens", async () => {
    const s = setup([reply, reply]);
    await s.autonomy.step(
      s.input(
        { iteration: 1, memo: {}, feedback: [], pendingTool },
        { resume: { kind: "tool_result", toolCallId: "k:askAddress", event: "odd" } },
      ),
    );
    expect(s.lastPrompt()).toContain("Tool askAddress finished with null.");
    const r = await s.autonomy.step(
      s.input(undefined, { resume: { kind: "tool_result", toolCallId: "k:askAddress", event: {} } }),
    );
    expect(r.memory.feedback).toEqual([]);
  });

  test("a suspension without logs or messages, and a workflow call with no input", async () => {
    const s = setup(
      [`${M}run\nawait tools.askAddress()\n${M}end`],
      [
        {
          ok: false,
          suspended: {
            toolId: "tool_AskAddr000",
            name: "askAddress",
            workflowId: "wf_AskAddres0",
            input: null,
            toolCallId: "k:askAddress",
          },
          logs: [{ level: "info", message: "before" }],
        },
      ],
    );
    const r = await s.autonomy.step(s.input());
    expect(r.outcome).toMatchObject({ type: "call", inputs: {} });
    expect(r.messages).toBeUndefined();
    expect(r.logs?.map((l) => l.message)).toEqual(["before", "askAddress ended the run block; waiting for its result"]);
  });

  test("a text that is only a citation token is not sent", async () => {
    const s = setup([`${M}say text\n[[c1]]\n${M}exit listen\n${M}end`]);
    const r = await s.autonomy.step(s.input());
    expect(r.messages).toBeUndefined();
  });
});
