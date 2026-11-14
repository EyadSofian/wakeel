import { AppError, type Json, newId } from "@wakeel/contracts";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "../client";
import {
  bridgeConnections,
  conversations,
  endUsers,
  inboundEvents,
  messages,
  outboxEvents,
  turns,
  webhookDeliveries,
} from "../schema/runtime";
import { currentWorkspace } from "./scope";
import type { StoredSigningSecret } from "./webhooks";

/**
 * The Bridge API's reads and writes (task 4.5, architecture §4.2, §9.1). Every call runs inside
 * `withWorkspace`, and every lookup by an external id is scoped to one connection, so a key for
 * connection A can never reach connection B's users or conversations.
 */

export interface ConnectionRecord {
  id: string;
  botId: string;
  name: string;
  target: "production" | "draft";
  status: "active" | "paused" | "disabled";
}

export async function createBridgeConnection(
  tx: Tx,
  input: {
    botId: string;
    name: string;
    target: "production" | "draft";
    webhookUrl?: string;
    subscribedEvents?: readonly string[];
  },
): Promise<ConnectionRecord> {
  const [row] = await tx
    .insert(bridgeConnections)
    .values({
      id: newId("conn"),
      workspaceId: currentWorkspace,
      botId: input.botId,
      name: input.name,
      target: input.target,
      webhookUrl: input.webhookUrl ?? null,
      ...(input.subscribedEvents ? { subscribedEvents: [...input.subscribedEvents] } : {}),
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return toConnection(row);
}

const toConnection = (row: typeof bridgeConnections.$inferSelect): ConnectionRecord => ({
  id: row.id,
  botId: row.botId,
  name: row.name,
  target: row.target as ConnectionRecord["target"],
  status: row.status as ConnectionRecord["status"],
});

/**
 * The emulator's draft connection for this builder session and bot, created on first use (ADR-025).
 * It has no webhook, no subscribed events and no keys; the Studio emulator routes run the Bridge
 * inbound path for it in-process. Removing the session removes it (0007).
 */
export async function ensureEmulatorConnection(
  tx: Tx,
  input: { botId: string; sessionId: string },
): Promise<ConnectionRecord> {
  await tx
    .insert(bridgeConnections)
    .values({
      id: newId("conn"),
      workspaceId: currentWorkspace,
      botId: input.botId,
      name: "Emulator",
      target: "draft",
      emulatorSessionId: input.sessionId,
    })
    .onConflictDoNothing({
      target: [bridgeConnections.emulatorSessionId, bridgeConnections.botId],
      where: sql`emulator_session_id is not null`,
    });
  const [row] = await tx
    .select()
    .from(bridgeConnections)
    .where(and(eq(bridgeConnections.emulatorSessionId, input.sessionId), eq(bridgeConnections.botId, input.botId)));
  if (!row) throw new Error("the emulator connection was neither inserted nor found");
  return toConnection(row);
}

export async function getBridgeConnection(tx: Tx, connectionId: string): Promise<ConnectionRecord | undefined> {
  const [row] = await tx.select().from(bridgeConnections).where(eq(bridgeConnections.id, connectionId));
  return row ? toConnection(row) : undefined;
}

export interface BridgeEndUser {
  id: string;
  externalId: string;
  attributes: Record<string, Json>;
  createdAt: Date;
}

const toUser = (row: typeof endUsers.$inferSelect): BridgeEndUser => ({
  id: row.id,
  externalId: row.externalId,
  attributes: (row.attributes ?? {}) as Record<string, Json>,
  createdAt: row.createdAt,
});

export async function findEndUser(
  tx: Tx,
  connectionId: string,
  externalId: string,
): Promise<BridgeEndUser | undefined> {
  const [row] = await tx
    .select()
    .from(endUsers)
    .where(and(eq(endUsers.connectionId, connectionId), eq(endUsers.externalId, externalId)));
  return row ? toUser(row) : undefined;
}

export async function getEndUserById(tx: Tx, endUserId: string): Promise<BridgeEndUser> {
  const [row] = await tx.select().from(endUsers).where(eq(endUsers.id, endUserId));
  if (!row) throw new AppError("not_found");
  return toUser(row);
}

/**
 * Creates the user on first use and merges `patch` into its attributes (§9.1). A key set to `null`
 * removes it. Two requests for a new user at once both succeed: the insert yields to the row that
 * won, then merges.
 */
export async function upsertEndUser(
  tx: Tx,
  input: { connectionId: string; botId: string; externalId: string; patch: Record<string, Json | null> },
): Promise<BridgeEndUser> {
  const set = Object.fromEntries(Object.entries(input.patch).filter(([, v]) => v !== null));
  const remove = Object.entries(input.patch)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  await tx
    .insert(endUsers)
    .values({
      id: newId("eu"),
      workspaceId: currentWorkspace,
      botId: input.botId,
      connectionId: input.connectionId,
      externalId: input.externalId,
      attributes: set,
    })
    .onConflictDoNothing({ target: [endUsers.connectionId, endUsers.externalId] });
  const [row] = await tx
    .update(endUsers)
    .set({
      // Keys travel as one JSON value: drizzle would spread an array into a parameter list.
      attributes: sql`(${endUsers.attributes} || ${JSON.stringify(set)}::jsonb) - array(select jsonb_array_elements_text(${JSON.stringify(remove)}::jsonb))`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(endUsers.connectionId, input.connectionId), eq(endUsers.externalId, input.externalId)))
    .returning();
  if (!row) throw new Error("the end user was neither inserted nor found");
  return toUser(row);
}

export interface BridgeConversationRecord {
  id: string;
  connectionId: string;
  externalId: string;
  endUserId: string;
  status: string;
  handoff: Record<string, Json> | null;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date | null;
  endedAt: Date | null;
  endedReason: string | null;
}

const toConversation = (row: typeof conversations.$inferSelect): BridgeConversationRecord => ({
  id: row.id,
  connectionId: row.connectionId,
  externalId: row.externalId,
  endUserId: row.endUserId,
  status: row.status,
  handoff: (row.handoff as Record<string, Json> | null) ?? null,
  createdAt: row.createdAt,
  lastActivityAt: row.lastActivityAt,
  expiresAt: row.expiresAt,
  endedAt: row.endedAt,
  endedReason: row.endedReason,
});

export async function findConversation(
  tx: Tx,
  connectionId: string,
  externalId: string,
): Promise<BridgeConversationRecord | undefined> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.connectionId, connectionId), eq(conversations.externalId, externalId)));
  return row ? toConversation(row) : undefined;
}

export async function getBridgeConversation(
  tx: Tx,
  conversationId: string,
): Promise<BridgeConversationRecord | undefined> {
  const [row] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  return row ? toConversation(row) : undefined;
}

/** Creates a conversation on first use; a concurrent request that created it first wins. */
export async function ensureConversation(
  tx: Tx,
  input: {
    connectionId: string;
    botId: string;
    endUserId: string;
    externalId: string;
    mode: "live" | "emulator" | "eval";
    state: Record<string, Json>;
    stateBytes: number;
  },
): Promise<BridgeConversationRecord> {
  await tx
    .insert(conversations)
    .values({
      id: newId("conv"),
      workspaceId: currentWorkspace,
      botId: input.botId,
      connectionId: input.connectionId,
      endUserId: input.endUserId,
      externalId: input.externalId,
      mode: input.mode,
      state: input.state,
      stateBytes: input.stateBytes,
    })
    .onConflictDoNothing({ target: [conversations.connectionId, conversations.externalId] });
  const found = await findConversation(tx, input.connectionId, input.externalId);
  if (!found) throw new Error("the conversation was neither inserted nor found");
  return found;
}

export interface StoredInbound {
  id: string;
  conversationId: string;
  seq: number;
  kind: string;
  payload: Record<string, Json>;
  turnId: string | null;
  processedAt: Date | null;
}

const toInbound = (row: typeof inboundEvents.$inferSelect): StoredInbound => ({
  id: row.id,
  conversationId: row.conversationId,
  seq: row.seq,
  kind: row.kind,
  payload: row.payload as Record<string, Json>,
  turnId: row.turnId,
  processedAt: row.processedAt,
});

/** The event first sent with this `Idempotency-Key` on this connection, if any. */
export async function findInboundByIdempotencyKey(
  tx: Tx,
  connectionId: string,
  key: string,
): Promise<StoredInbound | undefined> {
  const [row] = await tx
    .select()
    .from(inboundEvents)
    .where(and(eq(inboundEvents.connectionId, connectionId), eq(inboundEvents.idempotencyKey, key)));
  return row ? toInbound(row) : undefined;
}

/** Appends to the inbox with `seq = next_in_seq++` (§4.2). */
export async function insertInbound(
  tx: Tx,
  input: { conversationId: string; kind: string; payload: Record<string, Json>; idempotencyKey?: string },
): Promise<StoredInbound> {
  const [conv] = await tx
    .update(conversations)
    .set({ nextInSeq: sql`${conversations.nextInSeq} + 1` })
    .where(eq(conversations.id, input.conversationId))
    .returning({
      seq: sql<number>`(${conversations.nextInSeq} - 1)::bigint`.mapWith(Number),
      connectionId: conversations.connectionId,
    });
  if (!conv) throw new AppError("not_found");
  const [row] = await tx
    .insert(inboundEvents)
    .values({
      id: newId("evt"),
      workspaceId: currentWorkspace,
      connectionId: conv.connectionId,
      conversationId: input.conversationId,
      seq: conv.seq,
      kind: input.kind,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return toInbound(row);
}

/** A user message in the transcript (§4.2 step 2). Its seq comes from the transcript sequence. */
export async function insertUserMessage(
  tx: Tx,
  input: { conversationId: string; payload: Record<string, Json>; type: string; externalId?: string },
): Promise<{ id: string; seq: number; createdAt: Date }> {
  const [row] = await tx
    .insert(messages)
    .values({
      id: newId("msg"),
      workspaceId: currentWorkspace,
      conversationId: input.conversationId,
      seq: sql`nextval('messages_seq')`,
      direction: "in",
      type: input.type,
      payload: input.payload,
      externalId: input.externalId ?? null,
    })
    .returning({ id: messages.id, seq: messages.seq, createdAt: messages.createdAt });
  if (!row) throw new Error("insert returned no row");
  return row;
}

export interface TranscriptRow {
  id: string;
  seq: number;
  direction: "in" | "out";
  payload: Record<string, Json>;
  citations: Json[];
  turnId: string | null;
  externalId: string | null;
  createdAt: Date;
}

const toTranscript = (row: typeof messages.$inferSelect): TranscriptRow => ({
  id: row.id,
  seq: row.seq,
  direction: row.direction as "in" | "out",
  payload: row.payload as Record<string, Json>,
  citations: (row.citations ?? []) as Json[],
  turnId: row.turnId,
  externalId: row.externalId,
  createdAt: row.createdAt,
});

/** The transcript in ascending seq, after `afterSeq` (cursor pagination). */
/** The last `limit` transcript rows of a conversation, oldest first (the handoff summary, task 5.4). */
export async function recentTranscript(tx: Tx, conversationId: string, limit: number): Promise<TranscriptRow[]> {
  const rows = await tx
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse().map(toTranscript);
}

export async function listTranscript(
  tx: Tx,
  conversationId: string,
  options: { limit: number; afterSeq?: number },
): Promise<TranscriptRow[]> {
  const rows = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        options.afterSeq === undefined ? undefined : gt(messages.seq, options.afterSeq),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(options.limit);
  return rows.map(toTranscript);
}

export async function botMessagesOfTurn(tx: Tx, turnId: string): Promise<TranscriptRow[]> {
  const rows = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.turnId, turnId), eq(messages.direction, "out")))
    .orderBy(asc(messages.seq));
  return rows.map(toTranscript);
}

export interface TurnSummary {
  id: string;
  conversationId: string;
  status: string;
}

export async function getTurnSummary(tx: Tx, turnId: string): Promise<TurnSummary | undefined> {
  const [row] = await tx
    .select({ id: turns.id, conversationId: turns.conversationId, status: turns.status })
    .from(turns)
    .where(eq(turns.id, turnId));
  return row;
}

/**
 * The inbound event a `turnId` was promised for at 202 time (the API mints it; the worker uses it
 * when it starts the turn, or the turn of a coalesced group adopts it).
 */
export async function inboundForPlannedTurn(tx: Tx, turnId: string): Promise<StoredInbound | undefined> {
  const [row] = await tx
    .select()
    .from(inboundEvents)
    .where(sql`${inboundEvents.payload}->>'turnId' = ${turnId}`)
    .limit(1);
  return row ? toInbound(row) : undefined;
}

export interface OutboxRow {
  id: string;
  seq: number | null;
  type: string;
  payload: Record<string, Json>;
  ephemeral: boolean;
  createdAt: Date;
}

/**
 * A turn's outbox rows: ordered ones by seq, then (if asked) ephemeral ones. `after` skips rows
 * already seen, by id, for the SSE stream.
 */
export async function outboxOfTurn(
  tx: Tx,
  conversationId: string,
  turnId: string,
  options: { ephemeral: boolean },
): Promise<OutboxRow[]> {
  const rows = await tx
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.conversationId, conversationId),
        sql`${outboxEvents.payload}->>'turnId' = ${turnId}`,
        options.ephemeral ? undefined : isNotNull(outboxEvents.seq),
      ),
    )
    // Rows written in one transaction share created_at; ephemeral ones (no seq) come first there.
    .orderBy(asc(outboxEvents.createdAt), sql`${outboxEvents.seq} asc nulls first`);
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    type: r.type,
    payload: r.payload as Record<string, Json>,
    ephemeral: r.ephemeral,
    createdAt: r.createdAt,
  }));
}

/**
 * `listConversationEvents` (ADR-029 §6): the conversation's ordered events after `afterSeq`,
 * ascending. Ephemeral events have no seq and are never listed.
 */
export async function listConversationEvents(
  tx: Tx,
  conversationId: string,
  options: { afterSeq: number; limit: number },
): Promise<OutboxRow[]> {
  const rows = await tx
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.conversationId, conversationId),
        isNotNull(outboxEvents.seq),
        gt(outboxEvents.seq, options.afterSeq),
      ),
    )
    .orderBy(asc(outboxEvents.seq))
    .limit(options.limit);
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    type: r.type,
    payload: r.payload as Record<string, Json>,
    ephemeral: r.ephemeral,
    createdAt: r.createdAt,
  }));
}

/** The connection as `getConnection` and `testWebhook` need it. Signing secrets stay sealed. */
export interface ConnectionDetail extends ConnectionRecord {
  webhookUrl: string | null;
  subscribedEvents: string[];
  signingSecrets: StoredSigningSecret[];
}

export async function getConnectionDetail(tx: Tx, connectionId: string): Promise<ConnectionDetail | undefined> {
  const [row] = await tx.select().from(bridgeConnections).where(eq(bridgeConnections.id, connectionId));
  return row
    ? {
        ...toConnection(row),
        webhookUrl: row.webhookUrl,
        subscribedEvents: row.subscribedEvents,
        signingSecrets: row.signingSecrets as StoredSigningSecret[],
      }
    : undefined;
}

/** A connection in the Studio's list and detail (task 5.5, ADR-030). */
export interface StudioConnectionRecord extends ConnectionDetail {
  consecutiveDead: number;
  lastDelivery: { status: "delivered" | "failed" | "dead"; at: Date } | null;
  createdAt: Date;
}

/**
 * A bot's connections, newest first, each with its latest finished delivery attempt. The emulator's
 * per-session connections (ADR-025) are not listed.
 */
export async function listBotConnections(
  tx: Tx,
  botId: string,
  connectionId?: string,
): Promise<StudioConnectionRecord[]> {
  const rows = await tx
    .select()
    .from(bridgeConnections)
    .where(
      and(
        eq(bridgeConnections.botId, botId),
        isNull(bridgeConnections.emulatorSessionId),
        connectionId ? eq(bridgeConnections.id, connectionId) : undefined,
      ),
    )
    .orderBy(sql`${bridgeConnections.createdAt} desc`, sql`${bridgeConnections.id} desc`);
  if (rows.length === 0) return [];
  const last = await tx
    .selectDistinctOn([webhookDeliveries.connectionId], {
      connectionId: webhookDeliveries.connectionId,
      status: webhookDeliveries.status,
      attemptedAt: webhookDeliveries.attemptedAt,
    })
    .from(webhookDeliveries)
    .where(
      and(
        inArray(
          webhookDeliveries.connectionId,
          rows.map((r) => r.id),
        ),
        ne(webhookDeliveries.status, "pending"),
      ),
    )
    .orderBy(webhookDeliveries.connectionId, desc(webhookDeliveries.attemptedAt));
  const byConnection = new Map(
    last.map((r) => [
      r.connectionId,
      { status: r.status as "delivered" | "failed" | "dead", at: r.attemptedAt as Date },
    ]),
  );
  return rows.map((row) => ({
    ...toConnection(row),
    webhookUrl: row.webhookUrl,
    subscribedEvents: row.subscribedEvents,
    signingSecrets: row.signingSecrets as StoredSigningSecret[],
    consecutiveDead: row.consecutiveDead,
    lastDelivery: byConnection.get(row.id) ?? null,
    createdAt: row.createdAt,
  }));
}

export interface ConnectionPatch {
  name?: string;
  target?: "production" | "draft";
  webhookUrl?: string | null;
  subscribedEvents?: readonly string[];
  status?: "active" | "paused";
}

/**
 * Changes a bot's connection (not the emulator's). Setting `active` also turns a disabled
 * connection back on and clears its run of dead events (ADR-030 §1). `not_found` if it is not there.
 */
export async function updateBridgeConnection(
  tx: Tx,
  input: { botId: string; connectionId: string; patch: ConnectionPatch },
): Promise<void> {
  const { patch } = input;
  const rows = await tx
    .update(bridgeConnections)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.target !== undefined ? { target: patch.target } : {}),
      ...(patch.webhookUrl !== undefined ? { webhookUrl: patch.webhookUrl } : {}),
      ...(patch.subscribedEvents !== undefined ? { subscribedEvents: [...patch.subscribedEvents] } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.status === "active" ? { consecutiveDead: 0 } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(bridgeConnections.id, input.connectionId),
        eq(bridgeConnections.botId, input.botId),
        isNull(bridgeConnections.emulatorSessionId),
      ),
    )
    .returning({ id: bridgeConnections.id });
  if (rows.length === 0) throw new AppError("not_found");
}
