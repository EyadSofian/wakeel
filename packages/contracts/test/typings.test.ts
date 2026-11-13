import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  BotManifest,
  CODE_BODY_IGNORED_DIAGNOSTICS,
  generateTypings,
  newElementId,
  newId,
  schemaToTs,
  type TableSchema,
  type Variable,
  Workflow,
} from "../src/index";

/**
 * Task 2.9: the code editor's typings, generated from the bot. The snapshot is the reviewable
 * output for a sample bot; the compile tests prove the text is valid TypeScript and that it
 * accepts code using the guest API correctly and rejects the mistakes it exists to catch.
 */

const variable = (v: Omit<Variable, "id" | "sensitive"> & { sensitive?: boolean }): Variable => ({
  id: newElementId("var"),
  sensitive: false,
  ...v,
});

/** A small shop bot: every variable type, an enum, an object with a schema, inputs and outputs. */
function sampleBot() {
  const manifest = BotManifest.parse({
    name: "متجر النور",
    defaultLocale: "ar",
    locales: ["ar", "en"],
    settings: { models: { default: "openai:gpt-5", utility: "openai:gpt-5-mini" } },
    variables: [
      variable({ name: "storeName", scope: "bot", type: "string", default: "النور" }),
      variable({ name: "openHours", scope: "bot", type: "object", default: { from: 9, to: 21 } }),
      variable({
        name: "plan",
        scope: "user",
        type: "enum",
        enumValues: ["free", "pro"],
        default: "free",
        description: "Subscription plan.",
      }),
      variable({ name: "phone", scope: "user", type: "string", sensitive: true }),
      variable({ name: "language", scope: "conversation", type: "enum", enumValues: ["ar", "en"] }),
      variable({
        name: "cart",
        scope: "conversation",
        type: "object",
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { sku: { type: "string" }, qty: { type: "integer", minimum: 1 } },
                required: ["sku", "qty"],
              },
            },
            coupon: { type: "string", description: "Code typed by the user, e.g. RAMADAN */ 10" },
          },
          required: ["items"],
        },
      }),
      variable({ name: "lastOrderAt", scope: "conversation", type: "date" }),
    ],
    configVars: [
      { key: "SHOP_API_KEY", secret: true, description: "Key for the shop's order API." },
      { key: "SHOP_URL", secret: false },
    ],
    mainWorkflowId: newElementId("wf"),
  });
  const entry = newElementId("node");
  const exit = newElementId("node");
  const workflow = Workflow.parse({
    id: newElementId("wf"),
    name: "Track order",
    kind: "sub",
    inputs: [
      { name: "orderNumber", type: "string", description: "As the user typed it." },
      { name: "notify", type: "boolean", required: false },
    ],
    outputs: [{ name: "status", type: "string" }],
    variables: [
      variable({ name: "email", scope: "workflow", type: "string" }),
      variable({ name: "attempts", scope: "workflow", type: "number", default: 0 }),
      variable({
        name: "tags",
        scope: "workflow",
        type: "array",
        schema: { type: "array", items: { type: "string" } },
      }),
      variable({ name: "raw", scope: "workflow", type: "any" }),
    ],
    nodes: [
      { id: entry, name: "Entry", type: "entry" },
      { id: exit, name: "Exit", type: "exit", outputs: {} },
    ],
    edges: [{ id: newElementId("edge"), from: { nodeId: entry, port: "next" }, to: { nodeId: exit } }],
    layout: { [entry]: { x: 0, y: 0 }, [exit]: { x: 360, y: 0 } },
  });
  const tables: TableSchema[] = [
    {
      id: newId("tbl"),
      name: "orders",
      description: "Orders placed in the shop.",
      columns: [
        { id: newElementId("col"), name: "number", type: "string", required: true, unique: true, searchable: true },
        {
          id: newElementId("col"),
          name: "status",
          type: "enum",
          enumValues: ["placed", "shipped", "delivered"],
          required: true,
          unique: false,
          searchable: false,
        },
        { id: newElementId("col"), name: "total", type: "number", required: false, unique: false, searchable: false },
        { id: newElementId("col"), name: "placedAt", type: "date", required: true, unique: false, searchable: false },
        { id: newElementId("col"), name: "meta", type: "json", required: false, unique: false, searchable: false },
      ],
    },
  ];
  return { manifest, workflow, tables };
}

/**
 * Type-checks `body` as the inside of an async function, the way a Run code card runs, against
 * the typings with the editor's settings. Returns the messages of the errors found in `body`.
 */
function check(dts: string, body: string): string[] {
  const files: Record<string, string> = {
    "/guest-api.d.ts": dts,
    "/code.js": body,
  };
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) =>
    name in files ? ts.createSourceFile(name, files[name] ?? "", version) : read(name, version);
  host.fileExists = (name) => name in files || ts.sys.fileExists(name);
  host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
  const program = ts.createProgram(Object.keys(files), options, host);
  const ignored = new Set(CODE_BODY_IGNORED_DIAGNOSTICS);
  const all = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];
  const inDts = all.filter((d) => d.file?.fileName === "/guest-api.d.ts");
  if (inDts.length > 0) {
    throw new Error(inDts.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  }
  return all
    .filter((d) => d.file?.fileName === "/code.js" && !ignored.has(d.code))
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

describe("generateTypings (architecture §5.2)", () => {
  test("the sample bot's typings", async () => {
    const { manifest, workflow, tables } = sampleBot();
    await expect(generateTypings({ manifest, workflow, tables })).toMatchFileSnapshot(
      "__snapshots__/typings-sample.d.ts",
    );
  });

  test("the output is valid TypeScript and correct code type-checks", () => {
    const dts = generateTypings(sampleBot());
    const errors = check(
      dts,
      `
const email = workflow.email ?? "unknown";
workflow.attempts += 1;
workflow.tags = [...(workflow.tags ?? []), "vip"];
workflow.status = "found";
if (workflow.notify) log.info("notify", workflow.orderNumber.trim());
conversation.language = "ar";
conversation.cart = { items: [{ sku: "A-1", qty: 2 }], coupon: "RAMADAN" };
const plan = user.plan === "pro" ? "مميز" : "مجاني";
const country = user.attributes["country"];
const res = await fetch(env.SHOP_URL + "/orders/" + workflow.orderNumber, {
  headers: { authorization: "Bearer " + env.SHOP_API_KEY },
});
const body = await res.json();
const rows = await tables.orders.find({ where: { status: { in: ["placed", "shipped"] } }, limit: 5 });
const first = rows[0]?.placedAt.slice(0, 10);
const order = await tables.orders.get({ and: [{ number: { eq: workflow.orderNumber } }, { not: { total: { isNull: true } } }] });
await tables.orders.update({ number: { eq: "1" } }, { status: "delivered" });
const passages = await kb.search(event.text, { topK: 3 });
const answer = await ai.generate({ instructions: "Answer briefly.", input: passages.map((p) => p.text).join("\\n") });
await say(answer);
await say({ type: "choice", text: "تتبع طلب آخر؟", options: [{ label: "نعم", value: "yes" }] });
turn.lastQuery = event.text;
const key = ctx.idempotencyKey;
const opened = bot.openHours;
return { email, plan, country, body, first, order, key, opened, store: bot.storeName };
`,
    );
    expect(errors).toEqual([]);
  });

  test.each([
    ["a misspelt variable", "workflow.emial = 'a';", /Property 'emial' does not exist/],
    ["writing a bot variable", "bot.storeName = 'x';", /read-only/],
    ["writing an input that is not there", "workflow.orderNo = '1';", /orderNo/],
    ["a value outside an enum", "conversation.language = 'fr';", /not assignable/],
    ["a config variable that is not declared", "const k = env.MISSING;", /MISSING/],
    ["writing a config variable", "env.SHOP_URL = 'x';", /read-only/],
    ["a column that is not in the table", "await tables.orders.find({ where: { colour: { eq: 'red' } } });", /colour/],
    [
      "two operators in one condition",
      "await tables.orders.get({ number: { eq: '1', ne: '2' } });",
      /not assignable|ne/,
    ],
    ["a table that does not exist", "await tables.customers.find();", /customers/],
    ["a message type that does not exist", "await say({ type: 'video', url: 'https://x' });", /not assignable/],
    ["writing the event", "event.text = 'x';", /read-only/],
    ["timers, which the sandbox does not have", "setTimeout(() => {}, 10);", /setTimeout/],
    ["require, which the sandbox does not have", "const fs = require('fs');", /require|module/],
  ])("rejects %s", (_name, body, message) => {
    const errors = check(generateTypings(sampleBot()), body);
    expect(errors.join("\n")).toMatch(message);
  });

  test("an empty bot still gives valid typings", () => {
    const { manifest, workflow } = sampleBot();
    const bare = { ...manifest, variables: [], configVars: [] };
    const dts = generateTypings({ manifest: bare, workflow: { ...workflow, inputs: [], outputs: [], variables: [] } });
    expect(dts).toContain("declare const workflow: {};");
    expect(dts).toContain("declare const tables: {};");
    expect(check(dts, "log.info(event.text); return 1;")).toEqual([]);
  });

  test("builder text cannot end a comment or break a line comment", () => {
    const { manifest, workflow } = sampleBot();
    const named = { ...workflow, name: "Track\norder */ declare const x: 1;" };
    const dts = generateTypings({ manifest, workflow: named });
    expect(dts).not.toContain("\norder");
    expect(dts).toContain("RAMADAN *\\/ 10");
    expect(check(dts, "return 1;")).toEqual([]);
  });

  test("the same input gives the same text", () => {
    const bot = sampleBot();
    expect(generateTypings(bot)).toBe(generateTypings(bot));
  });
});

describe("schemaToTs", () => {
  test.each([
    [{ type: "string", format: "email" }, "string"],
    [{ type: "integer", minimum: 0 }, "number"],
    [{ type: ["string", "null"] }, "string | null"],
    [{ enum: ["a", "b"] }, '"a" | "b"'],
    [{ type: "array", items: { type: "number" } }, "number[]"],
    [{ type: "array" }, "Guest.Json[]"],
    [{ type: "object" }, "{ [key: string]: Guest.Json }"],
    [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, "{\n  a: string;\n}"],
    [{ type: "object", properties: { a: { type: "string" } } }, "{\n  a?: string;\n}"],
    [{ type: "object", properties: { "with space": { type: "boolean" } } }, '{\n  "with space"?: boolean;\n}'],
    [{}, "Guest.Json"],
    ["not a schema", "Guest.Json"],
  ])("%j → %s", (schema, expected) => {
    expect(schemaToTs(schema, "")).toBe(expected);
  });
});
