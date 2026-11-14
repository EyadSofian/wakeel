import { AutonomousNode } from "@wakeel/contracts";
import { makeBotDefinition } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import {
  buildPrompt,
  describeMessage,
  renderInstructions,
  schemaToTs,
  summarizeOverflow,
  toolsDts,
  variableTypeToTs,
} from "../../src/prompt/index";

/** Task 6.4: the prompt's parts, one table each. */

describe("schemaToTs", () => {
  test.each([
    [undefined, "unknown"],
    [{ type: "string" }, "string"],
    [{ type: "integer" }, "number"],
    [{ type: "boolean" }, "boolean"],
    [{ type: "null" }, "null"],
    [{ type: ["string", "null"] }, "string | null"],
    [{ enum: [] }, "never"],
    [{ enum: [1, "a"] }, '1 | "a"'],
    [{ type: "array", items: { type: "number" } }, "number[]"],
    [{ type: "array", items: { enum: ["a", "b"] } }, 'Array<"a" | "b">'],
    [{ type: "object" }, "Record<string, unknown>"],
    [{ type: "object", properties: { "order-id": { type: "string" } } }, '{\n  "order-id"?: string;\n}'],
    [{ type: "mystery" }, "unknown"],
  ])("%j → %s", (schema, ts) => {
    expect(schemaToTs(schema as Record<string, unknown> | undefined)).toBe(ts);
  });

  test.each([
    ["string", "string"],
    ["date", "string"],
    ["enum", "string"],
    ["number", "number"],
    ["boolean", "boolean"],
    ["object", "Record<string, unknown>"],
    ["array", "unknown[]"],
    ["any", "unknown"],
  ] as const)("variable type %s → %s", (type, ts) => {
    expect(variableTypeToTs(type)).toBe(ts);
  });
});

describe("toolsDts", () => {
  const definition = makeBotDefinition();
  test("a node with no tools declares an empty tools object", () => {
    const node = AutonomousNode.parse({ id: "node_NoTools000", type: "autonomous", name: "A", instructions: "x" });
    expect(toolsDts(node, definition)).toBe("declare const tools: {};");
  });

  test("a table tool gets one method per allowed operation; a code tool without side effects says nothing about retries", () => {
    const node = AutonomousNode.parse({
      id: "node_TableTool0",
      type: "autonomous",
      name: "A",
      instructions: "x",
      tools: [
        {
          id: "tool_Orders0000",
          type: "table",
          name: "orders",
          description: "The orders table.",
          tableId: "tbl_01m7a256m0a13warwhczsjhx9b",
          operations: ["find", "get"],
        },
        {
          id: "tool_Quote00000",
          type: "code",
          name: "quote",
          description: "Price a cart.",
          input: { type: "object" },
          source: "",
          sideEffects: false,
        },
        {
          id: "tool_Missing000",
          type: "workflow",
          name: "gone",
          description: "A workflow that was deleted.",
          workflowId: "wf_DeletedWf0",
        },
      ],
    });
    const dts = toolsDts(node, definition);
    expect(dts).toContain("orders: {\n    find(args: Record<string, unknown>): Promise<unknown>;\n    get(");
    expect(dts).toContain("  /** Price a cart. */\n  quote(input: Record<string, unknown>): Promise<unknown>;");
    expect(dts).toContain("gone(input: Record<string, never>): Promise<Record<string, never>>;");
  });
});

describe("describeMessage", () => {
  test.each([
    [{ type: "image", url: "u", caption: "إيصال" }, "[image: إيصال]"],
    [{ type: "file", url: "u", name: "invoice.pdf" }, "[file: invoice.pdf]"],
    [{ type: "image", url: "u" }, "[image]"],
    [{ type: "dropdown", text: "اختار", options: [{ label: "أ" }, { label: "ب" }] }, "اختار\n[dropdown: أ | ب]"],
    [{ type: "choice" }, "[choice: ]"],
    [{ type: "card", title: "t" }, "[card]"],
    [{}, "[message]"],
  ])("%j", (payload, text) => {
    expect(describeMessage(payload as never)).toBe(text);
  });
});

describe("instructions and the node block edge cases", () => {
  test("nested bot values, objects as JSON, missing values as nothing", () => {
    expect(
      renderInstructions("{{bot.hours.open}}-{{ bot.hours }} [{{ env.MISSING }}] {{ bot.name.first }}", {
        bot: { hours: { open: "9" }, name: "x" },
        env: {},
      }),
    ).toBe('9-{"open":"9"} [] ');
  });

  test("a node that is not conversational, has no exits and no handoff says so; a bot without a name", () => {
    const node = AutonomousNode.parse({
      id: "node_OneShot000",
      type: "autonomous",
      name: "A",
      instructions: "Classify.",
      conversational: false,
    });
    const built = buildPrompt({
      node,
      definition: makeBotDefinition(),
      bot: {},
      env: {},
      variables: [],
      transcript: [],
      feedback: [],
      iteration: 2,
      now: "2026-11-14T10:00:00.000Z",
    });
    expect(built.system).toContain("Exits: none. Finish with a message.");
    expect(built.system).toContain("Instructions:\nClassify.");
    expect(built.messages).toEqual([
      expect.objectContaining({ role: "user", content: expect.stringContaining("No variables are available to you.") }),
    ]);
  });

  test("a summary without an earlier one", async () => {
    let content = "";
    await summarizeOverflow(
      {
        complete: async (r) => {
          content = r.messages[0]?.content ?? "";
          return "s";
        },
      },
      { overflow: [{ direction: "out", payload: { type: "text", text: "تم" } }] },
    );
    expect(content).toBe('<data source="messages">\nAssistant: تم\n</data>');
  });
});
