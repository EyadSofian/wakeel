import {
  API_VERSION,
  type BotDefinition,
  BotDefinition as BotDefinitionSchema,
  type BotMessagePayload,
  type BridgeEvent,
  BridgeEvent as BridgeEventSchema,
  type ConversationState,
  ConversationState as ConversationStateSchema,
  emptyState,
  type Message,
  Message as MessageSchema,
  newElementId,
  newId,
  type SendMessageRequest,
  SendMessageRequest as SendMessageRequestSchema,
} from "@wakeel/contracts";

/**
 * Builders for valid contract objects. Every builder parses its result with the contract schema, so
 * a test can never start from an object the platform would reject, and defaults are applied the
 * same way as in production.
 */

const FIXED_TIME = "2026-11-13T09:00:00.000Z";

export interface BotDefinitionOptions {
  name?: string;
  /** Text the bot says after Start. Arabic by default. */
  greeting?: string;
}

/** Smallest valid bot: Main workflow with Start → one Standard node that says `greeting` → End. */
export function makeBotDefinition(options: BotDefinitionOptions = {}): BotDefinition {
  const mainId = newElementId("wf");
  const start = newElementId("node");
  const greet = newElementId("node");
  const end = newElementId("node");
  return BotDefinitionSchema.parse({
    schemaVersion: 1,
    manifest: {
      name: options.name ?? "بوت تجريبي",
      settings: { models: { default: "anthropic:test-model", utility: "anthropic:test-utility" } },
      mainWorkflowId: mainId,
    },
    workflows: [
      {
        id: mainId,
        name: "Main",
        kind: "main",
        nodes: [
          { id: start, type: "start", name: "Start" },
          {
            id: greet,
            type: "standard",
            name: "Greet",
            cards: [
              {
                id: newElementId("card"),
                type: "say",
                message: { type: "text", text: options.greeting ?? "أهلاً بك، كيف أقدر أساعدك؟" },
              },
            ],
          },
          { id: end, type: "end", name: "End" },
        ],
        edges: [
          { id: newElementId("edge"), from: { nodeId: start, port: "next" }, to: { nodeId: greet } },
          { id: newElementId("edge"), from: { nodeId: greet, port: "next" }, to: { nodeId: end } },
        ],
      },
    ],
  });
}

export function makeTextPayload(text = "مرحبا"): BotMessagePayload {
  return { type: "text", text, format: "markdown" };
}

export interface MessageOptions {
  conversationId?: string;
  seq?: number;
  direction?: "in" | "out";
  payload?: BotMessagePayload;
  createdAt?: string;
}

export function makeMessage(options: MessageOptions = {}): Message {
  return MessageSchema.parse({
    id: newId("msg"),
    conversationId: options.conversationId ?? newId("conv"),
    seq: options.seq ?? 0,
    direction: options.direction ?? "out",
    payload: options.payload ?? makeTextPayload(),
    createdAt: options.createdAt ?? FIXED_TIME,
  });
}

/** A `message.created` bridge event carrying a bot message. */
export function makeMessageCreatedEvent(options: { text?: string; seq?: number } = {}): BridgeEvent {
  const conversationId = newId("conv");
  return BridgeEventSchema.parse({
    id: newId("evt"),
    apiVersion: API_VERSION,
    type: "message.created",
    createdAt: FIXED_TIME,
    connectionId: newId("conn"),
    botId: newId("bot"),
    conversation: { id: conversationId, externalId: "ext-conv-1" },
    user: { id: newId("eu"), externalId: "ext-user-1" },
    turnId: newId("turn"),
    seq: options.seq ?? 1,
    data: { message: makeMessage({ conversationId, payload: makeTextPayload(options.text) }) },
  });
}

export function makeConversationState(overrides: Partial<ConversationState> = {}): ConversationState {
  return ConversationStateSchema.parse({ ...emptyState(), ...overrides });
}

export function makeSendMessageRequest(
  text = "عايز أعرف الأوردر بتاعي فين",
  userId = "ext-user-1",
): SendMessageRequest {
  return SendMessageRequestSchema.parse({ userId, message: { type: "text", text } });
}
