import {
  AppError,
  emptyState,
  type Json,
  Message,
  newId,
  ReplayTurnResponse,
  SendEventRequest,
  SendMessageRequest,
} from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import { getBot } from "./bots";
import {
  botMessagesOfTurn,
  ensureConversation,
  ensureEmulatorConnection,
  findInboundByIdempotencyKey,
  getTurnSummary,
  inboundForPlannedTurn,
  insertInbound,
  insertUserMessage,
  upsertEndUser,
} from "./bridge";
import { eventsOfTurn, getConversation } from "./runtime";

export async function createRecordedReplay(
  tx: Tx,
  input: { botId: string; sourceTurnId: string; sessionId: string; requestId: string; allowSideEffects: boolean },
) {
  await getBot(tx, input.botId);
  const turn = await getTurnSummary(tx, input.sourceTurnId);
  if (!turn) throw new AppError("not_found");
  const source = await getConversation(tx, turn.conversationId);
  if (source.botId !== input.botId || source.mode !== "live") throw new AppError("not_found");

  const connection = await ensureEmulatorConnection(tx, { botId: input.botId, sessionId: input.sessionId });
  await tx.execute(sql`select id from bridge_connections where id=${connection.id} for update`);
  const key = `replay-${input.requestId}`;
  const fingerprint = JSON.stringify([input.sourceTurnId, input.allowSideEffects]);
  const prior = await findInboundByIdempotencyKey(tx, connection.id, key);
  if (prior) {
    if (prior.payload["replayFingerprint"] !== fingerprint) throw new AppError("idempotency_mismatch");
    return ReplayTurnResponse.parse(prior.payload["replayResponse"]);
  }
  const events = await eventsOfTurn(tx, input.sourceTurnId);
  if (!events.length || events.some((event) => !["message", "event"].includes(event.kind))) {
    throw new AppError("replay_input_unavailable");
  }
  const recorded = events.map((event): { kind: string; payload: Record<string, Json> } => {
    if (event.kind === "message") {
      const parsed = SendMessageRequest.parse(event.payload);
      return {
        kind: event.kind,
        payload: {
          message: parsed.message as unknown as Json,
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        },
      };
    }
    const parsed = SendEventRequest.parse(event.payload);
    return { kind: event.kind, payload: { name: parsed.name, payload: parsed.payload } };
  });
  if (
    recorded.length > 1 &&
    recorded.some(
      (item) =>
        item.kind !== "message" ||
        !("message" in item.payload) ||
        (item.payload["message"] as { type?: string } | undefined)?.type !== "text",
    )
  )
    throw new AppError("replay_input_unavailable");

  const user = await upsertEndUser(tx, { botId: input.botId, connectionId: connection.id, externalId: key, patch: {} });
  const state = emptyState();
  const conversation = await ensureConversation(tx, {
    botId: input.botId,
    connectionId: connection.id,
    endUserId: user.id,
    externalId: key,
    mode: "emulator",
    state: state as unknown as Record<string, Json>,
    stateBytes: Buffer.byteLength(JSON.stringify(state)),
  });
  const turnId = newId("turn");
  const response = { conversationId: conversation.id, turnId, externalId: key };
  for (const [index, event] of recorded.entries()) {
    if ("message" in event.payload && event.payload["message"]) {
      const message = SendMessageRequest.parse(event.payload).message;
      await insertUserMessage(tx, {
        conversationId: conversation.id,
        payload: message as unknown as Record<string, Json>,
        type: message.type,
      });
    }
    await insertInbound(tx, {
      conversationId: conversation.id,
      kind: event.kind,
      payload: {
        ...event.payload,
        turnId,
        replay: { sourceTurnId: input.sourceTurnId, allowSideEffects: input.allowSideEffects, group: turnId },
        replayFingerprint: fingerprint,
        replayResponse: response,
      },
      ...(index === 0 ? { idempotencyKey: key } : {}),
    });
  }
  return ReplayTurnResponse.parse(response);
}

export async function recordedReplayResult(tx: Tx, input: { botId: string; turnId: string; sessionId: string }) {
  const turn = await getTurnSummary(tx, input.turnId);
  const planned = turn ? undefined : await inboundForPlannedTurn(tx, input.turnId);
  const conversationId = turn?.conversationId ?? planned?.conversationId;
  if (!conversationId) throw new AppError("not_found");
  const conversation = await getConversation(tx, conversationId);
  const allowed = await tx.execute(sql`select id from bridge_connections where id=${conversation.connectionId}
    and bot_id=${input.botId} and emulator_session_id=${input.sessionId}`);
  if (conversation.mode !== "emulator" || conversation.botId !== input.botId || !allowed.rows.length)
    throw new AppError("not_found");
  const messages = (turn ? await botMessagesOfTurn(tx, turn.id) : []).map((message) =>
    Message.parse({
      ...message,
      conversationId: conversation.id,
      turnId: message.turnId ?? undefined,
      externalId: message.externalId ?? undefined,
      createdAt: message.createdAt.toISOString(),
    }),
  );
  return { conversation, status: turn?.status ?? "queued", messages };
}
