import { newElementId } from "@wakeel/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { STUDIO, type Stack, signUp, startStack } from "./stack";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

test("paginates across inserts, searches mixed Arabic and updates rows with revisions", async () => {
  const actor = await signUp(stack.app);
  const ws = (await actor.send("POST", "/v1/workspaces", { name: "Rows", slug: "rows" })).json().id;
  const base = `/v1/workspaces/${ws}/bots`;
  const bot = (await actor.send("POST", base, { name: "المتجر", slug: "shop" })).json().id;
  const code = newElementId("col");
  const title = newElementId("col");
  const models = `${base}/${bot}/tables`;
  const table = (
    await actor.send("POST", models, {
      name: "orders",
      columns: [
        { id: code, name: "code", type: "number", unique: true, required: true },
        { id: title, name: "title", type: "string", searchable: true },
      ],
    })
  ).json();
  const rows = `${models}/${table.id}/rows`;
  const put = (n: number, label: string) => ({ [code]: n, [title]: label });

  const made = await actor.send("POST", rows, {
    rows: [put(10, "الفَاتُورَة ORD-12"), put(30, "شحن"), put(50, "مرتجع")],
  });
  expect(made.statusCode, made.body).toBe(201);
  const options = { sort: [{ column: "code", direction: "asc" }], limit: 1 };
  const find = (input: unknown) => actor.send("POST", `${rows}/find`, input);
  const first = (await find(options)).json();
  expect(first.data.map((x: { data: Record<string, unknown> }) => x.data[code])).toEqual([10]);
  expect(first.nextCursor).toBeTruthy();
  expect((await actor.send("POST", rows, { rows: [put(5, "أقدم"), put(20, "جديد")] })).statusCode).toBe(201);
  const second = (await find({ ...options, cursor: first.nextCursor })).json();
  expect(second.data.map((x: { data: Record<string, unknown> }) => x.data[code])).toEqual([20]);
  const search = (await find({ search: "فاتورة ORD 12" })).json();
  expect(search.data.map((x: { data: Record<string, unknown> }) => x.data[code])).toEqual([10]);

  const one = first.data[0];
  const url = `${rows}/${one.id}`;
  const get = await actor.get(url);
  expect(get.headers["etag"]).toBe(one.revision);
  const replace = () =>
    stack.app.inject({
      method: "PATCH",
      url,
      payload: { values: { [title]: "فاتورة جديدة" } },
      headers: { cookie: actor.cookie, origin: STUDIO, "x-csrf-token": actor.csrf, "if-match": one.revision },
    });
  expect((await replace()).statusCode).toBe(200);
  expect((await replace()).statusCode).toBe(409);
  const csv = await actor.send("POST", `${rows}/import`, { csv: 'code,title\r\n70,"فاتورة, ""مستمرة"""' });
  expect(csv.statusCode, csv.body).toBe(201);
  expect(csv.json().data[0].data).toEqual(put(70, 'فاتورة, "مستمرة"'));
  expect((await actor.send("POST", `${rows}/import`, { csv: "code,title\n80,تجربة\n70,مكرر" })).statusCode).toBe(409);
  expect((await find({ where: { code: { eq: 80 } } })).json().data).toEqual([]);

  const created = await actor.send("POST", `${rows}/upsert`, { on: "code", values: put(90, "أول") });
  expect(created.statusCode, created.body).toBe(201);
  const edit = await actor.send("POST", `${rows}/upsert`, { on: "code", values: put(90, "تاني") });
  expect(edit.statusCode, edit.body).toBe(200);
  expect(edit.json()).toMatchObject({ id: created.json().id, data: put(90, "تاني") });
  const removed = await stack.app.inject({
    method: "DELETE",
    url: `${rows}/${edit.json().id}`,
    headers: { cookie: actor.cookie, origin: STUDIO, "x-csrf-token": actor.csrf, "if-match": edit.headers["etag"] },
  });
  expect(removed.statusCode).toBe(204);
  expect((await find({ ...options, search: "شحن", cursor: first.nextCursor })).statusCode).toBe(400);
});
