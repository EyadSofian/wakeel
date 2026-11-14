import type { AddressInfo } from "node:net";
import {
  type BotDefinition,
  BotDefinition as BotDefinitionSchema,
  type ConversationState,
  type EventScope,
  emptyState,
  newElementId,
  newId,
} from "@wakeel/contracts";
import { type EnginePorts, runTurn, type StepCommit } from "@wakeel/engine";
import { createCodePort, createExpressionPort, createSandboxClient } from "@wakeel/sandbox-client";
import { createLogger } from "@wakeel/telemetry";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { createSandboxServer, type SandboxServer } from "../src/server";

/**
 * The card executors (task 4.3) over the real sandbox: the Code card through `createCodePort`, and
 * the expressions of Capture and Branch through `createExpressionPort`. The engine's unit tests use
 * fakes; this file checks the two sides agree.
 */

let pool: SandboxPool;
let server: SandboxServer;
let url: string;

beforeAll(async () => {
  pool = new SandboxPool({ size: 2 });
  await pool.start();
  server = createSandboxServer({
    pool,
    logger: createLogger({ service: "sandbox", level: "silent" }),
    requestFrameBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await server?.close();
  await pool?.close();
});

const ids = {
  total: newElementId("var"),
  points: newElementId("var"),
  rows: newElementId("var"),
  ref: newElementId("var"),
};

/** Main: Start → one node with `cards`; an optional node for the first card's error port. */
function bot(cards: unknown[], errorPortOf?: string): BotDefinition {
  const start = newElementId("node");
  const node = newElementId("node");
  const recover = newElementId("node");
  const main = newElementId("wf");
  return BotDefinitionSchema.parse({
    schemaVersion: 1,
    manifest: {
      name: "بوت",
      settings: { models: { default: "anthropic:m", utility: "anthropic:u" } },
      mainWorkflowId: main,
      variables: [
        { id: ids.total, name: "total", scope: "conversation", type: "number" },
        { id: ids.points, name: "points", scope: "user", type: "number" },
        { id: ids.ref, name: "ref", scope: "conversation", type: "string" },
      ],
      configVars: [{ key: "API_KEY", secret: true }],
    },
    workflows: [
      {
        id: main,
        name: "Main",
        kind: "main",
        variables: [{ id: ids.rows, name: "rows", scope: "workflow", type: "array" }],
        nodes: [
          { id: start, type: "start", name: "Start" },
          { id: node, type: "standard", name: "Work", cards },
          {
            id: recover,
            type: "standard",
            name: "Recover",
            cards: [{ id: newElementId("card"), type: "log", message: "recovered" }],
          },
        ],
        edges: [
          { id: newElementId("edge"), from: { nodeId: start, port: "next" }, to: { nodeId: node } },
          ...(errorPortOf
            ? [
                {
                  id: newElementId("edge"),
                  from: { nodeId: node, port: `card:${errorPortOf}:error` },
                  to: { nodeId: recover },
                },
              ]
            : []),
        ],
      },
    ],
  });
}

const text = (t: string): EventScope => ({
  kind: "message",
  text: t,
  message: { type: "text", text: t, format: "plain" },
  payload: {},
  metadata: {},
  conversationId: newId("conv"),
  externalConversationId: "c-1",
  userId: newId("eu"),
  externalUserId: "u-1",
  receivedAt: "2026-11-13T09:00:00.000Z",
});

/** The id of the bot's "Work" node. */
const workNode = (def: BotDefinition) => (def.workflows[0]?.nodes[1] as { id: string } | undefined)?.id ?? "";

async function turn(definition: BotDefinition, options: { state?: ConversationState; event?: EventScope } = {}) {
  const client = createSandboxClient({ url });
  const commits: StepCommit[] = [];
  const ports: EnginePorts = {
    sandbox: createExpressionPort(client),
    code: createCodePort(client),
    clock: { now: () => Date.now() },
    commitStep: async (c) => {
      commits.push(c);
    },
    emitEphemeral: async () => {},
  };
  const result = await runTurn(
    {
      turnId: newId("turn"),
      definition,
      state: options.state ?? emptyState(),
      event: options.event ?? text("عايز أعرف طلبي فين"),
      user: { vars: { [ids.points]: 100 }, attributes: { plan: "pro" } },
      env: { API_KEY: "sk-live-should-not-leak", CURRENCY: "EGP" },
      startedAt: Date.now(),
    },
    ports,
  );
  return {
    result,
    commits,
    messages: commits.flatMap((c) => c.messages),
    logs: commits.flatMap((c) => c.logs),
  };
}

describe("Code card", () => {
  test("writes variables, says Arabic text and logs, and the next card sees the writes", async () => {
    const source = [
      "const items = [{ sku: 'ORD-1', price: 150 }, { sku: 'ORD-2', price: 75 }];",
      "workflow.rows = items.map((i) => i.sku);",
      "conversation.total = items.reduce((s, i) => s + i.price, 0);",
      "user.points = user.points + 10;",
      "turn.note = 'تم';",
      "await say('لقيت ' + items.length + ' طلبات يا ' + user.attributes.plan);",
      "log.info('key', env.API_KEY);",
    ].join("\n");
    const { result, messages, logs, commits } = await turn(
      bot([
        { id: newElementId("card"), type: "code", source },
        {
          id: newElementId("card"),
          type: "log",
          message: "{{ conversation.total }} {{ env.CURRENCY }} / {{ turn.note }} / {{ workflow.rows.join(',') }}",
        },
      ]),
    );
    expect(result.error).toBeUndefined();
    expect(messages).toEqual([{ type: "text", text: "لقيت 2 طلبات يا pro", format: "markdown" }]);
    expect(result.state.conversationVars).toEqual({ [ids.total]: 225 });
    expect(commits.find((c) => c.user)?.user).toEqual({ vars: { [ids.points]: 110 } });
    expect(logs.at(-1)).toEqual({ level: "info", message: "225 EGP / تم / ORD-1,ORD-2" });
    // The secret is redacted by the sandbox before the log line reaches the engine.
    expect(JSON.stringify(logs)).not.toContain("sk-live-should-not-leak");
  });

  test("a throw fails the card with its line, through the error port", async () => {
    const failing = newElementId("card");
    const { result, logs, commits } = await turn(
      bot([{ id: failing, type: "code", source: "const a = 1;\nthrow new Error('رقم الطلب غلط');" }], failing),
    );
    expect(result.error).toBeUndefined();
    expect(logs.map((l) => l.message)).toEqual(["recovered"]);
    const failure = commits.flatMap((c) => c.failures)[0];
    expect(failure).toMatchObject({ code: "code_error", handledBy: "port" });
    expect(failure?.message).toContain("رقم الطلب غلط");
    expect(failure?.fix).toBe("See line 2. The trace shows the variables at that point.");
  });

  test("an endless loop stops at the card's time limit", async () => {
    const { result } = await turn(
      bot([{ id: newElementId("card"), type: "code", source: "for (;;) {}", timeoutMs: 200 }]),
    );
    expect(result.error).toMatchObject({ code: "code_timeout", message: "Your code ran longer than 200 ms" });
  });

  test("a write of the wrong type is refused by the engine", async () => {
    const { result } = await turn(
      bot([{ id: newElementId("card"), type: "code", source: "conversation.total = 'كتير';" }]),
    );
    expect(result.error?.message).toBe('"total" expects number but received string');
  });
});

describe("expressions of the cards", () => {
  function captureBot() {
    const ask = newElementId("card");
    const def = bot([
      {
        id: ask,
        type: "capture",
        prompt: { type: "text", text: "رقم الطلب؟" },
        kind: "text",
        into: ids.ref,
        validate: { expression: "value.startsWith('ORD-') && value.length > 4", message: "اكتبه كده: ORD-12345" },
      },
    ]);
    const node = workNode(def);
    const state: ConversationState = {
      ...emptyState(),
      status: "waiting_input",
      wait: { kind: "capture", nodeId: node, cardId: ask, attempts: 0, since: "2026-11-13T09:00:00.000Z" },
      stack: [{ workflowId: def.manifest.mainWorkflowId, nodeId: node, cardIndex: 0, vars: {}, inputs: {} }],
    };
    return { def, state };
  }

  test("a capture's validate expression sees the reply as `value`", async () => {
    const c = captureBot();
    const accepted = await turn(c.def, { state: c.state, event: text("ORD-45123") });
    expect(accepted.result.state.conversationVars).toEqual({ [ids.ref]: "ORD-45123" });
    const refused = await turn(c.def, { state: c.state, event: text("٤٥١٢٣") });
    expect(refused.messages.map((m) => (m.type === "text" ? m.text : m.type))).toEqual([
      "اكتبه كده: ORD-12345",
      "رقم الطلب؟",
    ]);
    expect(refused.result.state.wait).toMatchObject({ attempts: 1 });
  });

  test("Arabic-Indic digits are captured as a number", async () => {
    const ask = newElementId("card");
    const def = bot([
      {
        id: ask,
        type: "capture",
        prompt: { type: "text", text: "كام؟" },
        kind: "number",
        into: ids.total,
        validate: { expression: "value > 100", message: "أكبر من ١٠٠" },
      },
    ]);
    const node = workNode(def);
    const state: ConversationState = {
      ...emptyState(),
      status: "waiting_input",
      wait: { kind: "capture", nodeId: node, cardId: ask, attempts: 0, since: "2026-11-13T09:00:00.000Z" },
      stack: [{ workflowId: def.manifest.mainWorkflowId, nodeId: node, cardIndex: 0, vars: {}, inputs: {} }],
    };
    const { result } = await turn(def, { state, event: text("٢٥٠") });
    expect(result.state.conversationVars).toEqual({ [ids.total]: 250 });
  });

  test("branch conditions and set_variable expressions run in the sandbox", async () => {
    const def = bot([
      {
        id: newElementId("card"),
        type: "set_variable",
        assignments: [{ variableId: ids.total, value: "[150, 75].reduce((a, b) => a + b, 0)" }],
      },
      {
        id: newElementId("card"),
        type: "branch",
        branches: [{ id: newElementId("br"), label: "Big", when: "conversation.total > 1000" }],
      },
      {
        id: newElementId("card"),
        type: "say",
        message: { type: "text", text: "المجموع {{ conversation.total * 2 }} {{ env.CURRENCY }}" },
      },
    ]);
    const { result, messages } = await turn(def);
    expect(result.error).toBeUndefined();
    expect(messages).toEqual([{ type: "text", text: "المجموع 450 EGP", format: "markdown" }]);
  });
});
