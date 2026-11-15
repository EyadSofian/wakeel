import { newId } from "@wakeel/contracts";
import { expect, test } from "vitest";
import { cardId, harness, linearBot, message, run, varId } from "../turn/harness";

const tableId = newId("tbl");
const row = { id: newId("row"), title: "مرتجع ORD-12" };

test.each(["find", "get", "insert", "update", "upsert", "delete"] as const)(
  "%s Table card uses its evaluated arguments",
  async (operation) => {
    const into = varId();
    const result = operation === "find" ? [row] : operation === "delete" ? 1 : row;
    const writes = ["insert", "update", "upsert"].includes(operation);
    const filtered = ["find", "get", "update", "delete"].includes(operation);
    const bot = linearBot(
      [
        {
          id: cardId(),
          type: "table",
          tableId,
          operation,
          ...(operation === "delete" ? {} : { into }),
          ...(writes ? { values: { title: "event.text" } } : {}),
          ...(filtered ? { where: { title: { eq: "event.text" } } } : {}),
          ...(operation === "upsert" ? { upsertOn: "title" } : {}),
        },
      ],
      {
        variables: [{ id: into, name: "rows", scope: "conversation", type: operation === "find" ? "array" : "object" }],
      },
    );

    const h = harness();
    const calls: unknown[] = [];
    h.ports.tables = {
      execute: async (request) => {
        calls.push(request);
        return result;
      },
    };
    const { result: turn } = await run({ def: bot.def, h, event: message(row.title) });
    expect(calls).toEqual([
      expect.objectContaining({
        operation,
        target: { id: tableId },
        surface: "card",
        input: expect.objectContaining({
          ...(writes ? { values: { title: row.title } } : {}),
          ...(filtered ? { where: { title: { eq: row.title } } } : {}),
          ...(operation === "upsert" ? { on: "title" } : {}),
        }),
      }),
    ]);
    if (operation !== "delete") expect(turn.state.conversationVars[into]).toEqual(result);
  },
);

test("an empty get follows not_found and evaluates nested compare expressions", async () => {
  const bot = linearBot([
    {
      id: cardId(),
      type: "table",
      tableId,
      operation: "get",
      where: { and: [{ title: { in: ["event.text"] } }, { not: { code: { isNull: true } } }] },
      search: "{{event.text}}",
    },
  ]);
  const h = harness();
  h.ports.tables = {
    execute: async (call) => {
      expect(call.input).toMatchObject({
        where: { and: [{ title: { in: [row.title] } }, { not: { code: { isNull: true } } }] },
        search: row.title,
      });
      return null;
    },
  };
  const { commits } = await run({ def: bot.def, h, event: message(row.title) });
  expect(commits.some((commit) => commit.step?.outcome === "goto")).toBe(true);
});
