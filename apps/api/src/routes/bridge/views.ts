import { type EnvelopeContext, toBridgeEvent, toMessage } from "@wakeel/bridge";
import { AppError, type BridgeConversation, type BridgeUser, type Json, type TurnResult } from "@wakeel/contracts";
import {
  type BridgeConversationRecord,
  type BridgeEndUser,
  botMessagesOfTurn,
  getBridgeConversation,
  getEndUserById,
  getTurnSummary,
  inboundForPlannedTurn,
  outboxOfTurn,
  type Tx,
} from "@wakeel/db";

/**
 * Response bodies (04-contracts/bridge.ts). The user's `name`, `email`, `phone` and `locale` are kept
 * in `end_users.attributes` (§9.1: "user data in the request body is merged into attributes"), so
 * the bot reads them as `user.attributes.name`; the API also returns them as top-level fields.
 */
const PROFILE_FIELDS = ["name", "email", "phone", "locale"] as const;

export function userView(user: BridgeEndUser): BridgeUser {
  const view: BridgeUser = {
    id: user.id,
    externalId: user.externalId,
    attributes: user.attributes,
    createdAt: user.createdAt.toISOString(),
  };
  for (const field of PROFILE_FIELDS) {
    const value = user.attributes[field];
    if (typeof value === "string") view[field] = value;
  }
  return view;
}

/** The attributes patch for UserData: its `attributes`, then the profile fields over them. */
export function userPatch(data: {
  name?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  locale?: string | undefined;
  attributes?: Record<string, Json> | undefined;
}): Record<string, Json | null> {
  const patch: Record<string, Json | null> = { ...(data.attributes ?? {}) };
  for (const field of PROFILE_FIELDS) {
    const value = data[field];
    if (value !== undefined) patch[field] = value;
  }
  return patch;
}

export function conversationView(conv: BridgeConversationRecord, user: BridgeEndUser): BridgeConversation {
  const handoff = conv.handoff;
  return {
    id: conv.id,
    externalId: conv.externalId,
    user: userView(user),
    status: conv.status as BridgeConversation["status"],
    handoff: handoff
      ? {
          ...(typeof handoff["reason"] === "string" ? { reason: handoff["reason"] } : {}),
          ...(typeof handoff["summary"] === "string" ? { summary: handoff["summary"] } : {}),
        }
      : null,
    createdAt: conv.createdAt.toISOString(),
    lastActivityAt: conv.lastActivityAt.toISOString(),
    expiresAt: conv.expiresAt?.toISOString() ?? null,
    endedAt: conv.endedAt?.toISOString() ?? null,
    endedReason: conv.endedReason,
  };
}

/**
 * A turn's result. `turnId` may be one the API promised in a 202 for an event whose turn has not
 * started yet (`running`), or that was coalesced into the turn of an earlier event (that turn is
 * returned). The turn must belong to the caller's connection, or it is `not_found`.
 */
export async function turnResult(
  tx: Tx,
  turnId: string,
  scope: { connectionId: string; botId: string },
): Promise<TurnResult> {
  let actual = await getTurnSummary(tx, turnId);
  let conversationId = actual?.conversationId;
  if (!actual) {
    const planned = await inboundForPlannedTurn(tx, turnId);
    if (!planned) throw new AppError("not_found");
    conversationId = planned.conversationId;
    if (planned.turnId) actual = await getTurnSummary(tx, planned.turnId);
  }
  const conv = await getBridgeConversation(tx, conversationId as string);
  if (!conv || conv.connectionId !== scope.connectionId) throw new AppError("not_found");
  if (!actual) return { turnId, conversationId: conv.id, status: "running", messages: [], events: [] };

  const user = await getEndUserById(tx, conv.endUserId);
  const ctx: EnvelopeContext = {
    connectionId: scope.connectionId,
    botId: scope.botId,
    conversation: { id: conv.id, externalId: conv.externalId },
    user: { id: user.id, externalId: user.externalId },
  };
  const [messages, events] = await Promise.all([
    botMessagesOfTurn(tx, actual.id),
    outboxOfTurn(tx, conv.id, actual.id, { ephemeral: false }),
  ]);
  return {
    turnId: actual.id,
    conversationId: conv.id,
    status: actual.status as TurnResult["status"],
    messages: messages.map((m) => toMessage(m, conv.id)),
    events: events.map((e) => toBridgeEvent(e, ctx)),
  };
}
