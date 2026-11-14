import { z } from "zod";
import { ConversationId, EndUserId, IsoDateTime, Json } from "./common";
import { BridgeEvent } from "./event";
import { Message } from "./message";
import { ConversationStatus } from "./runtime";

/**
 * Bridge API response bodies (04-contracts/bridge-api.openapi.yaml: `User`, `Conversation`,
 * `Accepted`, `TurnResult`). The OpenAPI file is the published contract; these schemas mirror it
 * and `openapi-agreement.test.ts` keeps the two equal.
 */

/** The stored end user, as the Bridge API returns it. */
export const BridgeUser = z.object({
  id: EndUserId,
  externalId: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  locale: z.string().optional(),
  attributes: z.record(z.string(), Json),
  createdAt: IsoDateTime,
});
export type BridgeUser = z.infer<typeof BridgeUser>;

export const BridgeConversation = z.object({
  id: ConversationId,
  externalId: z.string(),
  user: BridgeUser.optional(),
  status: ConversationStatus,
  handoff: z
    .object({ requestedAt: IsoDateTime.optional(), reason: z.string().optional(), summary: z.string().optional() })
    .nullable()
    .optional(),
  createdAt: IsoDateTime,
  lastActivityAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable().optional(),
  endedAt: IsoDateTime.nullable().optional(),
  endedReason: z.string().nullable().optional(),
});
export type BridgeConversation = z.infer<typeof BridgeConversation>;

/** `202` from sendMessage and sendEvent: the input is stored and a turn is queued. */
export const Accepted = z.object({
  conversationId: z.string(),
  userId: z.string().optional(),
  /** Present when a message was stored. */
  messageId: z.string().optional(),
  turnId: z.string(),
  /** `handed_off`: stored, but the bot will not reply until the handoff is released. */
  status: z.enum(["queued", "handed_off"]),
});
export type Accepted = z.infer<typeof Accepted>;

/** A turn's output: `200` with `wait`, and `GET /turns/{turnId}`. */
export const TurnResult = z.object({
  turnId: z.string(),
  conversationId: z.string(),
  status: z.enum(["running", "completed", "waiting", "handed_off", "ended", "failed"]),
  /** Bot messages produced in this turn, in order. */
  messages: z.array(Message),
  /** Every non-ephemeral event of this turn, including the `message.created` events for the messages above. */
  events: z.array(BridgeEvent),
});
export type TurnResult = z.infer<typeof TurnResult>;
