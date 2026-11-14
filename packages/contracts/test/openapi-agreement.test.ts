import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import * as c from "../src/index";
import { compareShapes, type Shape, toShape } from "./schema-shape";

/**
 * 04-contracts/README.md rule 2: the hand-written Bridge API file and the zod schemas must agree on
 * field names, required lists and enums. The OpenAPI file stays in /docs: it is the published contract.
 */
const specPath = fileURLToPath(new URL("../../../docs/04-contracts/bridge-api.openapi.yaml", import.meta.url));
const spec = parse(readFileSync(specPath, "utf8")) as Record<string, unknown> & {
  info: { version: string };
  components: { schemas: Record<string, unknown> };
  webhooks: { bridgeEvent: { post: { parameters: { name: string }[] } } };
};

/** Requests are what a caller may send, so defaulted fields are optional: compare the input side. */
const zodShape = (schema: z.ZodType): Shape => {
  const json = z.toJSONSchema(schema, { io: "input", reused: "inline", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  return toShape(json, json);
};
const apiShape = (name: string): Shape => {
  if (!(name in spec.components.schemas)) throw new Error(`OpenAPI has no schema ${name}`);
  return toShape({ $ref: `#/components/schemas/${name}` }, spec);
};

/**
 * Differences that are intended, each with its reason. Paths use `$` for the schema root.
 * Keep this list short; every entry is a place where clients see something looser than the server.
 */
const ALLOWED: Record<string, string[]> = {
  // Problem.code is a closed enum in zod, an open string in OpenAPI so clients tolerate new codes.
  Problem: ["$.code"],
};

const PAIRS: [api: string, zod: z.ZodType][] = [
  ["SendMessageRequest", c.SendMessageRequest],
  ["SendEventRequest", c.SendEventRequest],
  ["UserData", c.UserData],
  ["Option", c.Option],
  ["CardAction", c.CardAction],
  ["CardBody", c.CardBody],
  ["TextMessage", c.TextMessage],
  ["ImageMessage", c.ImageMessage],
  ["FileMessage", c.FileMessage],
  ["LocationMessage", c.LocationMessage],
  ["ChoiceMessage", c.ChoiceMessage],
  ["DropdownMessage", c.DropdownMessage],
  ["CardMessage", c.CardMessage],
  ["CarouselMessage", c.CarouselMessage],
  ["CustomMessage", c.CustomMessage],
  ["PostbackMessage", c.PostbackMessage],
  ["UserMessage", c.UserMessagePayload],
  ["BotMessage", c.BotMessagePayload],
  ["Citation", c.Citation],
  ["Message", c.Message],
  ["MessageCreatedEvent", c.MessageCreatedEvent],
  ["TypingEvent", c.TypingEvent],
  ["HandoffRequestedEvent", c.HandoffRequestedEvent],
  ["ConversationEndedEvent", c.ConversationEndedEvent],
  ["TurnCompletedEvent", c.TurnCompletedEvent],
  ["ErrorEvent", c.ErrorEvent],
  ["BridgeEvent", c.BridgeEvent],
  ["Problem", c.Problem],
  ["User", c.BridgeUser],
  ["Conversation", c.BridgeConversation],
  ["Accepted", c.Accepted],
  ["TurnResult", c.TurnResult],
];

describe("OpenAPI and zod agree", () => {
  test.each(PAIRS)("%s", (name, schema) => {
    expect(compareShapes(zodShape(schema), apiShape(name), "$", new Set(ALLOWED[name] ?? []))).toEqual([]);
  });

  test("every message and event type in zod has an OpenAPI schema", () => {
    const union = (name: string) => apiShape(name) as Extract<Shape, { kind: "union" }>;
    expect(union("BotMessage").discriminators).toEqual([...c.BOT_MESSAGE_TYPES].sort());
    expect(union("BridgeEvent").discriminators).toEqual([...c.BRIDGE_EVENT_TYPES].sort());
  });

  test("subscribable events are exactly the bridge event types", () => {
    const connection = apiShape("Connection") as Extract<Shape, { kind: "object" }>;
    const subscribed = connection.props["subscribedEvents"] as Extract<Shape, { kind: "array" }>;
    expect(subscribed.items).toEqual({ kind: "enum", values: [...c.BRIDGE_EVENT_TYPES].sort() });
  });

  test("API version and webhook headers match event.ts", () => {
    expect(spec.info.version).toBe(c.API_VERSION);
    const headers = spec.webhooks.bridgeEvent.post.parameters.map((p) => p.name);
    expect(headers).toEqual(expect.arrayContaining([c.SIGNATURE_HEADER, c.EVENT_ID_HEADER, c.ATTEMPT_HEADER]));
  });

  test("conversation statuses match", () => {
    const conversation = apiShape("Conversation") as Extract<Shape, { kind: "object" }>;
    expect(conversation.props["status"]).toEqual({ kind: "enum", values: [...c.ConversationStatus.options].sort() });
  });
});

describe("the comparison catches drift", () => {
  test("a renamed field, a changed required list, an enum value and a union member", () => {
    const drifted = z.object({
      type: z.literal("choice"),
      body: z.string(),
      options: z.array(z.object({ label: z.string(), value: z.string(), id: z.string() })),
    });
    expect(compareShapes(zodShape(drifted), apiShape("ChoiceMessage"))).toEqual([
      "$.body: in zod, missing from OpenAPI",
      "$.text: in OpenAPI, missing from zod",
      "$: required differs (zod [body, options, type], OpenAPI [options, text, type])",
      "$.options[].id: in zod, missing from OpenAPI",
      "$.options[]: required differs (zod [id, label, value], OpenAPI [label, value])",
    ]);
    const status = z.object({ reason: z.enum(["completed", "manual"]), detail: z.string().optional() });
    const api = apiShape("ConversationEndedEvent") as Extract<Shape, { kind: "object" }>;
    const data = api.props["data"];
    if (!data) throw new Error("OpenAPI changed: ConversationEndedEvent.data missing");
    expect(compareShapes(zodShape(status), data)).toEqual([
      "$.reason: enum differs (zod [completed,manual], OpenAPI [completed,error,inactivity,manual])",
    ]);
    const union = z.discriminatedUnion("type", [c.TextMessage, c.ImageMessage]);
    expect(compareShapes(zodShape(union), apiShape("UserMessage"))).toHaveLength(1);
  });

  test("the Problem allowance is needed and is the only difference", () => {
    expect(compareShapes(zodShape(c.Problem), apiShape("Problem"))).toEqual(["$.code: zod is enum, OpenAPI is scalar"]);
  });
});
