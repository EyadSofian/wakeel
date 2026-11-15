import { z } from "zod";
import { ConnectionId, ConversationId, EndUserId, IsoDateTime } from "./common";
import { Message } from "./message";
import { ConversationStatus } from "./runtime";

const queryBoolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();
export const ConversationHistoryQuery = z.object({
  connectionId: ConnectionId.optional(),
  status: ConversationStatus.optional(),
  from: IsoDateTime.optional(),
  until: IsoDateTime.optional(),
  hasError: queryBoolean,
  handedOff: queryBoolean,
  search: z.string().trim().min(1).max(250).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(256).optional(),
});
export type ConversationHistoryQuery = z.infer<typeof ConversationHistoryQuery>;

export const ConversationHistoryItem = z.object({
  id: ConversationId,
  connectionId: ConnectionId,
  connectionName: z.string(),
  status: ConversationStatus,
  lastActivityAt: IsoDateTime,
  hasError: z.boolean(),
  user: z.object({
    id: EndUserId,
    externalId: z.string(),
    name: z.string().nullable(),
  }),
});
export type ConversationHistoryItem = z.infer<typeof ConversationHistoryItem>;

export const ConversationHistoryPage = z.object({
  data: z.array(ConversationHistoryItem),
  nextCursor: z.string().nullable(),
});
export const ConversationTranscriptPage = z.object({
  conversation: ConversationHistoryItem,
  messages: z.array(Message),
  nextCursor: z.string().nullable(),
});
