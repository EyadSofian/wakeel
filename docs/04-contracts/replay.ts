import { z } from "zod";
import { ConversationId, TurnId } from "./common";
import { Message } from "./message";
import { Trace } from "./trace";

export const ReplayTurnRequest = z.strictObject({
  requestId: z.uuid(),
  allowSideEffects: z.boolean().default(false),
});
export const ReplayTurnResponse = z.object({
  conversationId: ConversationId,
  turnId: TurnId,
  externalId: z.string(),
});
export const ReplayResult = z.object({
  status: z.string(),
  messages: z.array(Message),
  trace: Trace.nullable(),
});
