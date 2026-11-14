import { z } from "zod";
import { BotId, ConnectionId, ConversationId, EndUserId, EventId, IsoDateTime, Json, Locale, TurnId } from "./common";
import { BotMessagePayload, Message, UserMessagePayload } from "./message";

export const API_VERSION = "2026-11-01" as const;

/* ------------------------------------------------------------------ */
/* Inbound: bridge → platform                                          */
/* ------------------------------------------------------------------ */

/** Data about the end user, merged into the stored user on every call (like Botpress `updateUser`). */
export const UserData = z.object({
  name: z.string().max(200).optional(),
  email: z.email().optional(),
  phone: z.string().max(40).optional(),
  locale: Locale.optional(),
  /** Free-form attributes, readable as `user.attributes.*`. Max 16 KB serialised. */
  attributes: z.record(z.string().max(64), Json).optional(),
});
export type UserData = z.infer<typeof UserData>;

export const SendMessageRequest = z.object({
  /** The bridge's id for the end user. Required on the first message of a conversation. */
  userId: z.string().min(1).max(255).optional(),
  user: UserData.optional(),
  message: UserMessagePayload,
  /** The bridge's id for this message; stored and echoed, also used for de-duplication. */
  externalMessageId: z.string().max(255).optional(),
  /** Opaque data available to the bot as `event.metadata`. Max 8 KB. */
  metadata: z.record(z.string().max(64), Json).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendEventRequest = z.object({
  userId: z.string().min(1).max(255).optional(),
  user: UserData.optional(),
  /** Matched against Trigger nodes with `on.kind = "event"`. */
  name: z.string().min(1).max(64),
  payload: z.record(z.string(), Json).default({}),
});
export type SendEventRequest = z.infer<typeof SendEventRequest>;

/** Internal inbox record kinds (`inbound_events.kind`). */
/** `run_from` is internal: only the Studio emulator inserts it, on emulator conversations (ADR-025). */
export const InboundKind = z.enum([
  "message",
  "event",
  "user_update",
  "tool_result",
  "handoff_release",
  "timeout",
  "run_from",
]);
export type InboundKind = z.infer<typeof InboundKind>;

/** The read-only `event` object visible to expressions and code during a turn. */
export const EventScope = z.object({
  kind: InboundKind,
  /** Text of the user's message, or the label of a postback; empty string otherwise. */
  text: z.string(),
  message: UserMessagePayload.optional(),
  name: z.string().optional(),
  payload: z.record(z.string(), Json).default({}),
  metadata: z.record(z.string(), Json).default({}),
  /** Data supplied by the model when an Autonomous Node left through an exit. */
  exit: z.object({ name: z.string(), data: Json }).optional(),
  conversationId: ConversationId,
  externalConversationId: z.string(),
  userId: EndUserId,
  externalUserId: z.string(),
  receivedAt: IsoDateTime,
});
export type EventScope = z.infer<typeof EventScope>;

/* ------------------------------------------------------------------ */
/* Outbound: platform → bridge (webhook, SSE, sync response)           */
/* ------------------------------------------------------------------ */

const envelope = {
  /** Unique per event. Receivers must treat repeats as already processed. */
  id: EventId,
  apiVersion: z.literal(API_VERSION),
  createdAt: IsoDateTime,
  connectionId: ConnectionId,
  botId: BotId,
  conversation: z.object({ id: ConversationId, externalId: z.string() }),
  user: z.object({ id: EndUserId, externalId: z.string() }),
  turnId: TurnId.optional(),
  /**
   * Position in this conversation's ordered stream, starting at 1.
   * Absent on ephemeral events. A gap means an earlier event was dead-lettered.
   */
  seq: z.number().int().positive().optional(),
  /** Best-effort, unordered, never retried. */
  ephemeral: z.boolean().default(false),
};

export const MessageCreatedEvent = z.object({
  ...envelope,
  type: z.literal("message.created"),
  data: z.object({ message: Message.extend({ payload: BotMessagePayload }) }),
});

export const TypingEvent = z.object({
  ...envelope,
  type: z.literal("typing"),
  data: z.object({ state: z.enum(["on", "off"]) }),
});

export const HandoffRequestedEvent = z.object({
  ...envelope,
  type: z.literal("handoff.requested"),
  data: z.object({
    reason: z.string(),
    /** Short account of the conversation so far, in the conversation's language. Empty if disabled. */
    summary: z.string(),
    variables: z.record(z.string(), Json).default({}),
  }),
});

export const ConversationEndedEvent = z.object({
  ...envelope,
  type: z.literal("conversation.ended"),
  data: z.object({
    reason: z.enum(["completed", "inactivity", "manual", "error"]),
    detail: z.string().optional(),
  }),
});

export const TurnCompletedEvent = z.object({
  ...envelope,
  type: z.literal("turn.completed"),
  data: z.object({
    status: z.enum(["completed", "waiting", "handed_off", "ended", "failed"]),
    messageCount: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
});

export const ErrorEvent = z.object({
  ...envelope,
  type: z.literal("error"),
  data: z.object({
    code: z.string(),
    /** Safe to log; not meant for end users. */
    message: z.string(),
    /** True when sending the same input again may succeed. */
    retryable: z.boolean(),
  }),
});

export const BridgeEvent = z.discriminatedUnion("type", [
  MessageCreatedEvent,
  TypingEvent,
  HandoffRequestedEvent,
  ConversationEndedEvent,
  TurnCompletedEvent,
  ErrorEvent,
]);
export type BridgeEvent = z.infer<typeof BridgeEvent>;
export type BridgeEventType = BridgeEvent["type"];

export const BRIDGE_EVENT_TYPES: readonly BridgeEventType[] = [
  "message.created",
  "typing",
  "handoff.requested",
  "conversation.ended",
  "turn.completed",
  "error",
];

/* ------------------------------------------------------------------ */
/* Webhook signing                                                     */
/* ------------------------------------------------------------------ */

export const SIGNATURE_HEADER = "X-Wakeel-Signature";
export const EVENT_ID_HEADER = "X-Wakeel-Event-Id";
export const ATTEMPT_HEADER = "X-Wakeel-Delivery-Attempt";
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Seconds after each failed attempt; after the last one the event is dead-lettered. ±20% jitter. */
export const RETRY_SCHEDULE_SECONDS = [5, 30, 120, 600, 1_800, 7_200, 21_600, 43_200] as const;

/**
 * Header value: `t=<unix seconds>,v1=<hex>[,v1=<hex>]`
 * where hex = HMAC-SHA256(secret, `${t}.${rawBody}`). One `v1` per active secret.
 */
export const signaturePayload = (timestamp: number, rawBody: string) => `${timestamp}.${rawBody}`;
