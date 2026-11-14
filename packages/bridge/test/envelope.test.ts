import { API_VERSION, newId } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { canonicalJson, eventIdOf, requestFingerprint, sseFrame, toBridgeEvent, toMessage } from "../src/index";

const ctx = {
  connectionId: newId("conn"),
  botId: newId("bot"),
  conversation: { id: newId("conv"), externalId: "chat-1" },
  user: { id: newId("eu"), externalId: "user-1" },
};

describe("toBridgeEvent", () => {
  test("adds the envelope to an outbox row; the event id is the row's ULID under evt_", () => {
    const outboxId = newId("out");
    const turnId = newId("turn");
    const event = toBridgeEvent(
      {
        id: outboxId,
        seq: 3,
        type: "turn.completed",
        payload: { turnId, data: { status: "completed", messageCount: 1, durationMs: 120 } },
        ephemeral: false,
        createdAt: new Date("2026-11-13T09:00:00.000Z"),
      },
      ctx,
    );
    expect(event).toEqual({
      id: `evt_${outboxId.slice(4)}`,
      apiVersion: API_VERSION,
      createdAt: "2026-11-13T09:00:00.000Z",
      ...ctx,
      turnId,
      seq: 3,
      ephemeral: false,
      type: "turn.completed",
      data: { status: "completed", messageCount: 1, durationMs: 120 },
    });
    expect(eventIdOf(outboxId)).toBe(event.id);
  });

  test("ephemeral events carry no seq; a row that breaks the contract is refused", () => {
    const typing = toBridgeEvent(
      {
        id: newId("out"),
        seq: null,
        type: "typing",
        payload: { data: { state: "on" } },
        ephemeral: true,
        createdAt: new Date(),
      },
      ctx,
    );
    expect(typing).not.toHaveProperty("seq");
    expect(() =>
      toBridgeEvent(
        {
          id: newId("out"),
          seq: 1,
          type: "typing",
          payload: { data: { state: "maybe" } },
          ephemeral: false,
          createdAt: new Date(),
        },
        ctx,
      ),
    ).toThrow();
  });
});

test("toMessage returns the API's Message, Arabic text untouched", () => {
  const msg = toMessage(
    {
      id: newId("msg"),
      seq: 7,
      direction: "out",
      payload: { type: "text", text: "أهلاً منى", format: "markdown" },
      citations: [],
      turnId: null,
      externalId: null,
      createdAt: new Date("2026-11-13T09:00:00.000Z"),
    },
    ctx.conversation.id,
  );
  expect(msg).toMatchObject({ seq: 7, direction: "out", payload: { text: "أهلاً منى" } });
  expect(msg).not.toHaveProperty("turnId");
});

describe("idempotency fingerprints", () => {
  test("ignore key order and undefined fields, and differ by operation and content", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    const a = requestFingerprint("sendMessage", { message: { type: "text", text: "مرحبا" }, userId: "u" });
    expect(requestFingerprint("sendMessage", { userId: "u", message: { text: "مرحبا", type: "text" } })).toBe(a);
    expect(requestFingerprint("sendEvent", { userId: "u", message: { text: "مرحبا", type: "text" } })).not.toBe(a);
    expect(requestFingerprint("sendMessage", { userId: "u", message: { text: "مرحبا!", type: "text" } })).not.toBe(a);
  });
});

test("sseFrame writes one event", () => {
  expect(sseFrame("typing", { state: "on" })).toBe('event: typing\ndata: {"state":"on"}\n\n');
});
