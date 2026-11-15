import { AutonomousNode, type BotDefinition } from "@wakeel/contracts";
import { makeBotDefinition } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import {
  callTool,
  isToolSuspended,
  mapCitations,
  resumedFeedback,
  type ToolCodeOutcome,
  type ToolDeps,
  toolCallIdFor,
} from "../../src/tools/index";

/**
 * Task 6.6 (architecture §6.5, ADR-032 §2, ADR-035): one tool call from the model's code. Code tools
 * run in the sandbox as their own exec; workflow tools end the run block at the call site; knowledge
 * base and table tools say they are not available yet.
 */

const SUB = "wf_AskAddres0";
const base = makeBotDefinition({ name: "مساعد النور" });
const definition = {
  ...base,
  workflows: [
    ...base.workflows,
    {
      id: SUB,
      name: "Ask address",
      kind: "sub",
      variables: [],
      inputs: [
        { name: "reason", type: "string", required: true },
        { name: "attempt", type: "number", required: false },
        { name: "area", type: "enum", required: false, schema: { enum: ["cairo", "giza"] } },
        { name: "when", type: "date", required: false },
        { name: "urgent", type: "boolean", required: false },
        { name: "meta", type: "object", required: false },
        { name: "lines", type: "array", required: false },
        { name: "extra", type: "any", required: false },
      ],
      outputs: [{ name: "address", type: "string", required: true }],
      nodes: [],
      edges: [],
    },
  ],
} as unknown as BotDefinition;

const node = AutonomousNode.parse({
  id: "node_Assistant0",
  type: "autonomous",
  name: "Assistant",
  instructions: "Help with orders.",
  tools: [
    {
      id: "tool_Lookup0000",
      type: "code",
      name: "lookupOrder",
      description: "Finds an order.",
      input: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
      output: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
      source: "return { status: 'shipped' }",
      sideEffects: false,
      timeoutMs: 1000,
    },
    {
      id: "tool_AskAddr000",
      type: "workflow",
      name: "askAddress",
      description: "Asks for the address.",
      workflowId: SUB,
    },
    {
      id: "tool_Missing000",
      type: "workflow",
      name: "gone",
      description: "Points nowhere.",
      workflowId: "wf_Nowhere000",
    },
    {
      id: "tool_Help000000",
      type: "kb_search",
      name: "searchHelp",
      description: "d",
      kbIds: ["kb_01m7a256m0a13warwhczsjhx9b"],
    },
    {
      id: "tool_Orders0000",
      type: "table",
      name: "orders",
      description: "d",
      tableId: "tbl_01m7a256m0a13warwhczsjhx9b",
      operations: ["find"],
    },
  ],
});

function deps(outcome: ToolCodeOutcome = { ok: true, value: { status: "shipped" }, patches: {}, said: [] }) {
  const runs: Parameters<ToolDeps["code"]["run"]>[0][] = [];
  const warnings: string[] = [];
  const d: ToolDeps = {
    definition,
    code: {
      run: async (r) => {
        runs.push(r);
        return outcome;
      },
    },
    scopes: { conversation: { orderNumber: "5678" } },
    idempotencyKey: "turn_x:3:run",
    warn: (message) => warnings.push(message),
  };
  return { d, runs, warnings };
}

async function suspension(input: unknown) {
  try {
    await callTool(node, { tool: "askAddress", input: input as never }, deps().d);
  } catch (error) {
    if (isToolSuspended(error)) return error.pending;
    throw error;
  }
  throw new Error("the call did not suspend");
}

describe("code tools", () => {
  test("run with the input on the code's first line and return the value", async () => {
    const { d, runs } = deps();
    await expect(callTool(node, { tool: "lookupOrder", input: { number: "5678" } }, d)).resolves.toEqual({
      status: "shipped",
    });
    expect(runs[0]).toMatchObject({
      source: `const input = {"number":"5678"}; return { status: 'shipped' }`,
      timeoutMs: 1000,
      idempotencyKey: "turn_x:3:run:lookupOrder",
      scopes: { conversation: { orderNumber: "5678" } },
    });
  });

  test("input that does not match the schema is refused before anything runs", async () => {
    const { d, runs } = deps();
    await expect(callTool(node, { tool: "lookupOrder", input: { number: 5678 } }, d)).rejects.toMatchObject({
      code: "tool_input_invalid",
    });
    expect(runs).toHaveLength(0);
  });

  test("output that does not match the schema fails the call", async () => {
    const { d } = deps({ ok: true, value: { state: "x" }, patches: {}, said: [] });
    await expect(callTool(node, { tool: "lookupOrder", input: { number: "1" } }, d)).rejects.toMatchObject({
      code: "tool_failed",
    });
  });

  test("a failed run fails the call with the code's message", async () => {
    const { d } = deps({ ok: false, message: "orders is not defined" });
    await expect(callTool(node, { tool: "lookupOrder", input: { number: "1" } }, d)).rejects.toMatchObject({
      code: "tool_failed",
      params: { message: "orders is not defined" },
    });
  });

  test("variable writes and messages inside a tool are dropped with a warning (ADR-032 §2)", async () => {
    const { d, warnings } = deps({
      ok: true,
      value: { status: "shipped" },
      patches: { conversation: { set: { orderNumber: "1" } } },
      said: ["hi"],
    });
    await callTool(node, { tool: "lookupOrder", input: { number: "1" } }, d);
    expect(warnings).toHaveLength(1);
  });
});

describe("tools that are not built yet, or not on the node", () => {
  test.each([
    ["orders", "tables are not available yet"],
    ["deleteEverything", "this node has no such tool"],
  ])("%s fails with a message the model can read", async (tool, message) => {
    await expect(callTool(node, { tool, input: {} }, deps().d)).rejects.toMatchObject({
      code: "tool_failed",
      params: { message },
    });
  });
});

describe("workflow tools (ADR-035)", () => {
  test("a valid call suspends with the workflow, its inputs and a call id derived from the step", async () => {
    const pending = await suspension({ reason: "توصيل الطلب", attempt: 1, area: "giza" });
    expect(pending).toEqual({
      toolId: "tool_AskAddr000",
      name: "askAddress",
      workflowId: SUB,
      input: { reason: "توصيل الطلب", attempt: 1, area: "giza" },
      toolCallId: "turn_x:3:run:askAddress",
    });
  });

  test("every type is accepted when it fits", async () => {
    const input = { reason: "x", when: "2026-11-14", urgent: true, meta: {}, lines: [], extra: 1 };
    expect((await suspension(input)).input).toEqual(input);
  });

  test("the call id is the same when the step runs again", () => {
    expect(toolCallIdFor("turn_x:3:run", "askAddress")).toBe(toolCallIdFor("turn_x:3:run", "askAddress"));
    expect(toolCallIdFor("turn_x:4:run", "askAddress")).not.toBe(toolCallIdFor("turn_x:3:run", "askAddress"));
  });

  test("null input counts as no input", async () => {
    await expect(callTool(node, { tool: "askAddress", input: null }, deps().d)).rejects.toMatchObject({
      code: "tool_input_invalid",
      params: { message: "reason is required" },
    });
  });

  test.each([
    [{}, "reason is required"],
    [{ reason: 5 }, "reason must be a string"],
    [{ reason: "x", attempt: "1" }, "attempt must be a number"],
    [{ reason: "x", area: "alex" }, "area"],
    [{ reason: "x", area: 1 }, "area must be an enum"],
    [{ reason: "x", when: "soon" }, "when must be a date"],
    [{ reason: "x", urgent: "yes" }, "urgent must be a boolean"],
    [{ reason: "x", meta: [] }, "meta must be an object"],
    [{ reason: "x", lines: {} }, "lines must be an array"],
    [{ reason: "x", street: "Tahrir" }, "street is not an input of this workflow"],
    ["x", "the input must be an object"],
  ])("input %j is refused: %s", async (input, message) => {
    await expect(callTool(node, { tool: "askAddress", input: input as never }, deps().d)).rejects.toMatchObject({
      code: "tool_input_invalid",
      params: { message: expect.stringContaining(message) },
    });
  });

  test("a workflow that no longer exists fails the call", async () => {
    await expect(callTool(node, { tool: "gone", input: {} }, deps().d)).rejects.toMatchObject({
      code: "tool_failed",
    });
  });
});

describe("resumed feedback (architecture §6.3)", () => {
  const pending = { toolId: "tool_AskAddr000", toolCallId: "k:askAddress", name: "askAddress", input: {} };

  test("outputs of a returned workflow, and what did not happen", () => {
    const text = resumedFeedback(pending, { outputs: { address: "١٢ شارع التحرير" } });
    expect(text).toBe(
      'Tool askAddress finished with {"address":"١٢ شارع التحرير"}. Code after that call did not run, and the variables it set were not kept.',
    );
  });

  test("a submitted result or error", () => {
    expect(resumedFeedback(pending, { result: { paid: true } })).toContain('finished with {"paid":true}');
    expect(resumedFeedback(pending, { error: "card declined" })).toContain("Tool askAddress failed: card declined.");
  });

  test("a long result is cut", () => {
    expect(resumedFeedback(pending, { result: "x".repeat(10_000) }).length).toBeLessThan(4_200);
  });
});

describe("citations (architecture §6.5)", () => {
  const sources = {
    c1: { documentId: "doc_01m7a256m0a13warwhczsjhx9b", chunkId: "chk_01m7a256m0a13warwhczsjhx9b", title: "الشحن" },
    c2: { documentId: "doc_01m7a256m0a13warwhczsjhx9c", chunkId: "chk_01m7a256m0a13warwhczsjhx9c", title: "Returns" },
  };

  test("known tokens become citations numbered in order of first use; the tokens leave the text", () => {
    const r = mapCitations("الشحن بياخد ٣ أيام [[c2]] والاسترجاع ١٤ يوم [[c1]] [[c2]].", sources);
    expect(r.text).toBe("الشحن بياخد ٣ أيام والاسترجاع ١٤ يوم.");
    expect(r.citations.map((c) => [c.index, c.title])).toEqual([
      [1, "Returns"],
      [2, "الشحن"],
    ]);
  });

  test("unknown tokens are stripped and cite nothing", () => {
    expect(mapCitations("Ships in 3 days [[c9]].", {})).toEqual({ text: "Ships in 3 days.", citations: [] });
  });

  test("text without tokens is unchanged", () => {
    expect(mapCitations("Hello  there", sources)).toEqual({ text: "Hello  there", citations: [] });
  });
});

describe("explicit knowledge tools", () => {
  test("uses only the node's declared KBs and returns Arabic passages", async () => {
    const { d } = deps();
    const seen: unknown[] = [];
    d.kbSearch = async (request) => {
      seen.push(request);
      return [{ text: "الطلب اتشحن", cite: "[[c1]]" }];
    };
    expect(await callTool(node, { tool: "searchHelp", input: "وين وصل ORD-12؟" }, d)).toEqual([
      { text: "الطلب اتشحن", cite: "[[c1]]" },
    ]);
    expect(seen[0]).toMatchObject({ query: "وين وصل ORD-12؟", kbIds: ["kb_01m7a256m0a13warwhczsjhx9b"] });
    await expect(callTool(node, { tool: "searchHelp", input: { kbIds: ["foreign"] } }, d)).rejects.toMatchObject({
      code: "tool_input_invalid",
    });
    await expect(callTool(node, { tool: "searchHelp", input: "سؤال", operation: "delete" }, d)).rejects.toMatchObject({
      code: "tool_input_invalid",
    });
  });
  test("missing search configuration remains a visible model error", async () => {
    await expect(callTool(node, { tool: "searchHelp", input: "أرجّع إزاي؟" }, deps().d)).rejects.toMatchObject({
      code: "model_not_configured",
    });
  });
});
