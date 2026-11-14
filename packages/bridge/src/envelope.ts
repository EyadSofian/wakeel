import { API_VERSION, BridgeEvent, type Json, Message } from "@wakeel/contracts";

/**
 * Turns outbox rows into Bridge events (04-contracts/event.ts). The worker stores `{ turnId, data }`
 * per row; the envelope is added on the way out, the same way for webhooks, SSE and `wait`.
 *
 * Event ids: the contract's envelope `id` is an `evt_` id, while outbox rows are `out_` (§2.2). An
 * event's id is its outbox row's ULID under the `evt_` prefix, so it is stable across retries and a
 * receiver can de-duplicate on it.
 */

export interface EnvelopeContext {
  connectionId: string;
  botId: string;
  conversation: { id: string; externalId: string };
  user: { id: string; externalId: string };
}

export interface OutboxLike {
  id: string;
  seq: number | null;
  type: string;
  payload: Record<string, Json>;
  ephemeral: boolean;
  createdAt: Date;
}

export const eventIdOf = (outboxId: string): string => `evt_${outboxId.slice(outboxId.indexOf("_") + 1)}`;

export function toBridgeEvent(row: OutboxLike, ctx: EnvelopeContext): BridgeEvent {
  const turnId = typeof row.payload["turnId"] === "string" ? row.payload["turnId"] : undefined;
  return BridgeEvent.parse({
    id: eventIdOf(row.id),
    apiVersion: API_VERSION,
    createdAt: row.createdAt.toISOString(),
    connectionId: ctx.connectionId,
    botId: ctx.botId,
    conversation: ctx.conversation,
    user: ctx.user,
    ...(turnId ? { turnId } : {}),
    ...(row.seq === null ? {} : { seq: row.seq }),
    ephemeral: row.ephemeral,
    type: row.type,
    data: row.payload["data"],
  });
}

export interface TranscriptLike {
  id: string;
  seq: number;
  direction: "in" | "out";
  payload: Record<string, Json>;
  citations: Json[];
  turnId: string | null;
  externalId: string | null;
  createdAt: Date;
}

/** A transcript row as the API returns it (`Message`). */
export function toMessage(row: TranscriptLike, conversationId: string): Message {
  return Message.parse({
    id: row.id,
    conversationId,
    seq: row.seq,
    direction: row.direction,
    payload: row.payload,
    citations: row.citations,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.externalId ? { externalId: row.externalId } : {}),
    createdAt: row.createdAt.toISOString(),
  });
}
