import { readFileSync } from "node:fs";
import { ListTableSchemasResponse, newElementId, TableSchemaResponse } from "@wakeel/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parse } from "yaml";
import { STUDIO, type Stack, signUp, startStack } from "./stack";

const spec = parse(
  readFileSync(new URL("../../../docs/04-contracts/table-api.openapi.yaml", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, { operationId?: string }>>;
};

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

test("table schema API scopes the resource and guards edits with its revision", async () => {
  const member = await signUp(stack.app);
  const ws = (await member.send("POST", "/v1/workspaces", { name: "Tables", slug: "tables" })).json().id;
  const bots = `/v1/workspaces/${ws}/bots`;
  const first = (await member.send("POST", bots, { name: "المتجر", slug: "shop" })).json().id;
  const second = (await member.send("POST", bots, { name: "الفرع", slug: "branch" })).json().id;
  const root = `${bots}/${first}/tables`;
  const created = await member.send("POST", root, {
    name: "orders",
    columns: [{ id: newElementId("col"), name: "orderNumber", type: "string", required: true }],
  });
  expect(created.statusCode, created.body).toBe(201);
  const table = TableSchemaResponse.parse(created.json());
  expect(created.headers["etag"]).toBe(table.revision);
  expect((await member.get(`${bots}/${second}/tables/${table.id}`)).statusCode).toBe(404);
  expect(ListTableSchemasResponse.parse((await member.get(root)).json()).data).toMatchObject([
    { id: table.id, name: "orders" },
  ]);
  const url = `${root}/${table.id}`;
  expect(TableSchemaResponse.parse((await member.get(url)).json())).toEqual(table);
  const patch = () =>
    stack.app.inject({
      method: "PATCH",
      url,
      payload: { name: "returnOrders" },
      headers: { cookie: member.cookie, origin: STUDIO, "x-csrf-token": member.csrf, "if-match": table.revision },
    });
  const updated = await patch();
  expect(updated.statusCode).toBe(200);
  expect((await patch()).statusCode).toBe(409);
  const deleted = await stack.app.inject({
    method: "DELETE",
    url,
    headers: {
      cookie: member.cookie,
      origin: STUDIO,
      "x-csrf-token": member.csrf,
      "if-match": updated.headers["etag"],
    },
  });
  expect(deleted.statusCode).toBe(204);
  expect((await member.get(url)).statusCode).toBe(404);
});

test("mounts the schema routes described by OpenAPI", () => {
  const types = ["get", "post", "patch", "delete"] as const;
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    types.flatMap((method) => (item[method]?.operationId ? [{ path, method }] : [])),
  );
  expect(operations).toHaveLength(5);
  for (const { path, method } of operations) {
    const url = path.replace(/\{(\w+)\}/g, ":$1");
    expect(stack.app.hasRoute({ method, url })).toBe(true);
  }
});
