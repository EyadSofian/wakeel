import { Accepted, ConversationHistoryPage, ConversationTranscriptPage } from "@wakeel/contracts";
import { sql } from "@wakeel/db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Stack, signUp, startStack } from "./stack";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ bridge: true });
});
afterAll(async () => {
  await stack?.stop();
});

test("lists scoped live conversations, filters by mixed-direction text, and returns the transcript", async () => {
  const owner = await signUp(stack.app);
  const stranger = await signUp(stack.app);
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "History", slug: "history" })).json().id as string;
  const otherWs = (await stranger.send("POST", "/v1/workspaces", { name: "Other", slug: "other" })).json().id as string;
  const root = `/v1/workspaces/${ws}/bots`;
  const botId = (await owner.send("POST", root, { name: "المتجر", slug: "shop" })).json().id as string;
  const otherBot = (await owner.send("POST", root, { name: "Other bot", slug: "other-bot" })).json().id as string;
  const body = (text: string) => ({ userId: "a-1", user: { name: "منى" }, message: { type: "text", text } });
  const base = `${root}/${botId}`;
  const text = "عايزة فاتورة ORD-12";
  const first = Accepted.parse(
    (await owner.send("POST", `${base}/emulator/conversations/first/messages`, body(text))).json(),
  );
  await owner.send("POST", `${base}/emulator/conversations/second/messages`, body("فاتورة ORD-21"));
  await stack.db.withWorkspace(ws, (tx) =>
    tx.execute(sql`update conversations set mode='live', status='handed_off'
    where id=${first.conversationId}`),
  );

  const path = `${base}/conversations`;
  const found = await owner.get(`${path}?handedOff=true&search=${encodeURIComponent("فاتورة ord-12")}`);
  expect(found.statusCode, found.body).toBe(200);
  expect(ConversationHistoryPage.parse(found.json()).data).toMatchObject([
    { id: first.conversationId, status: "handed_off", user: { name: "منى" }, hasError: false },
  ]);
  expect(ConversationHistoryPage.parse((await owner.get(path)).json()).data).toHaveLength(1);
  expect(ConversationHistoryPage.parse((await owner.get(`${path}?hasError=true`)).json()).data).toEqual([]);

  const transcript = await owner.get(`${path}/${first.conversationId}`);
  expect(transcript.statusCode, transcript.body).toBe(200);
  expect(ConversationTranscriptPage.parse(transcript.json()).messages).toMatchObject([{ payload: { text } }]);
  expect((await owner.get(`${root}/${otherBot}/conversations/${first.conversationId}`)).statusCode).toBe(404);
  expect(
    (await stranger.get(`/v1/workspaces/${otherWs}/bots/${botId}/conversations/${first.conversationId}`)).statusCode,
  ).toBe(404);
});
