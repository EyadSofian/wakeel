import { AppError, ConversationState, type Json, newId } from "@wakeel/contracts";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
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

/**
 * The turn worker's reads and writes on the runtime tables (task 4.4, architecture §4.3, ADR-008).
 * Every call runs inside `withWorkspace`. Writes that change the conversation are fenced by the
 * lease epoch: when another worker has taken the lease, they throw `LeaseLostError` and the caller
 * stops without further side effects.
 */

/** The lease was taken by another worker: `lease_epoch` no longer matches. */
export class LeaseLostError extends Error {
  constructor(readonly conversationId: string) {
    super(`The lease on ${conversationId} was lost to another worker.`);
    this.name = "LeaseLostError";
  }
}

export interface ConversationRecord {
  id: string;
  botId: string;
  connectionId: string;
  endUserId: string;
  externalId: string;
  mode: string;
  status: string;
  versionId: string | null;
  state: ConversationState;
  leaseEpoch: number;
  lastActivityAt: Date;
}

export interface EndUserRecord {
  id: string;
  externalId: string;
  vars: Record<string, Json>;
  attributes: Record<string, Json>;
}

export interface InboundEventRecord {
  id: string;
  connectionId: string;
  seq: number;
  kind: string;
  payload: Record<string, Json>;
  receivedAt: Date;
  turnId: string | null;
}

export interface TurnRecord {
  id: string;
  triggerEventId: string;
  stepCount: number;
  startedAt: Date;
}

const asObject = (value: unknown): Record<string, Json> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : {};

/**
 * Takes the conversation's lease when nobody holds a live one (§4.3). Returns the new epoch, or
 * undefined when another worker holds it.
 */
export async function acquireConversationLease(
  tx: Tx,
  conversationId: string,
  owner: string,
  leaseMs: number,
): Promise<number | undefined> {
  const rows = await tx
    .update(conversations)
    .set({
      leaseOwner: owner,
      leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
      leaseEpoch: sql`${conversations.leaseEpoch} + 1`,
    })
    .where(
      and(
        eq(conversations.id, conversationId),
        sql`(${conversations.leaseUntil} is null or ${conversations.leaseUntil} < now())`,
      ),
    )
    .returning({ epoch: conversations.leaseEpoch });
  return rows[0]?.epoch;
}

/** Extends a held lease (the heartbeat). False when it was lost. */
export async function renewConversationLease(
  tx: Tx,
  conversationId: string,
  epoch: number,
  leaseMs: number,
): Promise<boolean> {
  const rows = await tx
    .update(conversations)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${leaseMs / 1000})` })
    .where(and(eq(conversations.id, conversationId), eq(conversations.leaseEpoch, epoch)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

/** Gives the lease up so the next job can take it at once. A lease already lost is left alone. */
export async function releaseConversationLease(tx: Tx, conversationId: string, epoch: number): Promise<void> {
  await tx
    .update(conversations)
    .set({ leaseOwner: null, leaseUntil: null })
    .where(and(eq(conversations.id, conversationId), eq(conversations.leaseEpoch, epoch)));
}

export async function getConversation(tx: Tx, conversationId: string): Promise<ConversationRecord> {
  const [row] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!row) throw new AppError("not_found", {}, { detail: `Conversation ${conversationId} was not found.` });
  return {
    id: row.id,
    botId: row.botId,
    connectionId: row.connectionId,
    endUserId: row.endUserId,
    externalId: row.externalId,
    mode: row.mode,
    status: row.status,
    versionId: row.versionId,
    state: ConversationState.parse(row.state),
    leaseEpoch: row.leaseEpoch,
    lastActivityAt: row.lastActivityAt,
  };
}

export async function getEndUser(tx: Tx, endUserId: string): Promise<EndUserRecord> {
  const [row] = await tx.select().from(endUsers).where(eq(endUsers.id, endUserId));
  if (!row) throw new AppError("not_found", {}, { detail: `End user ${endUserId} was not found.` });
  return { id: row.id, externalId: row.externalId, vars: asObject(row.vars), attributes: asObject(row.attributes) };
}

const toEvent = (row: typeof inboundEvents.$inferSelect): InboundEventRecord => ({
  id: row.id,
  connectionId: row.connectionId,
  seq: row.seq,
  kind: row.kind,
  payload: asObject(row.payload),
  receivedAt: row.receivedAt,
  turnId: row.turnId,
});

/** The oldest unprocessed inbound event: the worker drains in `seq` order. */
export async function nextUnprocessedEvent(tx: Tx, conversationId: string): Promise<InboundEventRecord | undefined> {
  const [row] = await tx
    .select()
    .from(inboundEvents)
    .where(and(eq(inboundEvents.conversationId, conversationId), isNull(inboundEvents.processedAt)))
    .orderBy(asc(inboundEvents.seq))
    .limit(1);
  return row ? toEvent(row) : undefined;
}

/** Unprocessed events after `seq`, in order (for coalescing). */
export async function unprocessedEventsAfter(
  tx: Tx,
  conversationId: string,
  seq: number,
): Promise<InboundEventRecord[]> {
  const rows = await tx
    .select()
    .from(inboundEvents)
    .where(
      and(
        eq(inboundEvents.conversationId, conversationId),
        isNull(inboundEvents.processedAt),
        gt(inboundEvents.seq, seq),
      ),
    )
    .orderBy(asc(inboundEvents.seq));
  return rows.map(toEvent);
}

/** The events a turn was started for, in order (one, or several when coalesced). */
export async function eventsOfTurn(tx: Tx, turnId: string): Promise<InboundEventRecord[]> {
  const rows = await tx
    .select()
    .from(inboundEvents)
    .where(eq(inboundEvents.turnId, turnId))
    .orderBy(asc(inboundEvents.seq));
  return rows.map(toEvent);
}

/** The turn a worker started for this event and did not finish, if any. */
export async function runningTurnFor(tx: Tx, triggerEventId: string): Promise<TurnRecord | undefined> {
  const [row] = await tx
    .select()
    .from(turns)
    .where(and(eq(turns.triggerEventId, triggerEventId), eq(turns.status, "running")));
  return row
    ? { id: row.id, triggerEventId: row.triggerEventId, stepCount: row.stepCount, startedAt: row.startedAt }
    : undefined;
}

/**
 * Starts a turn for `events` (the first is the trigger) and links the events to it, so a worker
 * that resumes the turn finds the same group. Fenced by the lease.
 */
export async function startTurn(
  tx: Tx,
  input: {
    conversationId: string;
    botId: string;
    versionId: string | null;
    epoch: number;
    eventIds: string[];
    /** The id the Bridge API promised in its 202 (task 4.5); a new one when absent. */
    id?: string;
  },
): Promise<TurnRecord> {
  await assertLease(tx, input.conversationId, input.epoch);
  const [triggerEventId] = input.eventIds;
  if (!triggerEventId) throw new Error("startTurn needs at least one event");
  const [row] = await tx
    .insert(turns)
    .values({
      id: input.id ?? newId("turn"),
      workspaceId: currentWorkspace,
      conversationId: input.conversationId,
      botId: input.botId,
      versionId: input.versionId,
      triggerEventId,
      status: "running",
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  await tx.update(inboundEvents).set({ turnId: row.id }).where(inArray(inboundEvents.id, input.eventIds));
  return { id: row.id, triggerEventId, stepCount: 0, startedAt: row.startedAt };
}

async function assertLease(tx: Tx, conversationId: string, epoch: number): Promise<void> {
  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.leaseEpoch, epoch)))
    .for("update");
  if (rows.length === 0) throw new LeaseLostError(conversationId);
}

export interface ConversationWrite {
  state?: ConversationState;
  stateBytes?: number;
  endedReason?: string | null;
  handoff?: Record<string, Json> | null;
  touchActivity?: boolean;
  /** Minutes after the last activity; 0 or null clears `expires_at`. */
  timeoutMinutes?: number | null;
}

/**
 * Writes the conversation, fenced by the lease (§4.3: "Every state write includes AND lease_epoch =
 * $epoch"). Zero rows means the lease was lost: throws `LeaseLostError`.
 */
export async function writeConversation(
  tx: Tx,
  conversationId: string,
  epoch: number,
  write: ConversationWrite,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (write.state) {
    set["state"] = ConversationState.parse(write.state);
    set["status"] = write.state.status;
    set["stateBytes"] = write.stateBytes ?? 0;
  }
  if (write.endedReason !== undefined) {
    set["endedReason"] = write.endedReason;
    set["endedAt"] = write.endedReason === null ? null : sql`now()`;
  }
  if (write.handoff !== undefined) set["handoff"] = write.handoff;
  if (write.touchActivity) set["lastActivityAt"] = sql`now()`;
  if (write.timeoutMinutes !== undefined) {
    const activity = write.touchActivity ? sql`now()` : conversations.lastActivityAt;
    set["expiresAt"] = write.timeoutMinutes ? sql`${activity} + make_interval(mins => ${write.timeoutMinutes})` : null;
  }
  const rows = await tx
    .update(conversations)
    .set(set)
    .where(and(eq(conversations.id, conversationId), eq(conversations.leaseEpoch, epoch)))
    .returning({ id: conversations.id });
  if (rows.length === 0) throw new LeaseLostError(conversationId);
}

export interface NewBotMessage {
  id: string;
  type: string;
  payload: Record<string, Json>;
  turnId: string;
}

/** Inserts bot messages in order; `seq` comes from the transcript sequence (migration 0006). */
export async function insertBotMessages(
  tx: Tx,
  conversationId: string,
  rows: readonly NewBotMessage[],
): Promise<{ id: string; seq: number; createdAt: Date }[]> {
  const out: { id: string; seq: number; createdAt: Date }[] = [];
  // One at a time, so the sequence follows the order the bot produced them.
  for (const m of rows) {
    const [row] = await tx
      .insert(messages)
      .values({
        id: m.id,
        workspaceId: currentWorkspace,
        conversationId,
        seq: sql`nextval('messages_seq')`,
        direction: "out",
        type: m.type,
        payload: m.payload,
        turnId: m.turnId,
      })
      .returning({ id: messages.id, seq: messages.seq, createdAt: messages.createdAt });
    if (!row) throw new Error("insert returned no row");
    out.push(row);
  }
  return out;
}

export interface NewOutboxEvent {
  type: string;
  payload: Record<string, Json>;
  ephemeral?: boolean;
}

/**
 * Appends events to the conversation's outbox. Ordered events take `next_out_seq` in turn; the
 * counter moves under the lease fence. Ephemeral events have no seq.
 *
 * In the same transaction, each event the connection subscribes to gets a pending first delivery
 * attempt, due at `at` (ADR-028 §1): only when the connection has a webhook URL and the
 * conversation is not an eval run. Returns how many deliveries were created, so the caller knows
 * whether to wake the `webhook` queue.
 */
export async function appendOutbox(
  tx: Tx,
  input: { conversationId: string; connectionId: string; epoch: number; at?: Date },
  events: readonly NewOutboxEvent[],
): Promise<number> {
  if (events.length === 0) return 0;
  const ordered = events.filter((e) => !e.ephemeral).length;
  let next = 0;
  if (ordered > 0) {
    const rows = await tx
      .update(conversations)
      .set({ nextOutSeq: sql`${conversations.nextOutSeq} + ${ordered}` })
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.leaseEpoch, input.epoch)))
      .returning({ next: conversations.nextOutSeq });
    if (!rows[0]) throw new LeaseLostError(input.conversationId);
    next = rows[0].next - ordered;
  }
  const rows = events.map((e) => ({
    id: newId("out"),
    workspaceId: currentWorkspace,
    connectionId: input.connectionId,
    conversationId: input.conversationId,
    seq: e.ephemeral ? null : next++,
    type: e.type,
    payload: e.payload,
    ephemeral: e.ephemeral ?? false,
  }));
  await tx.insert(outboxEvents).values(rows);

  const [target] = await tx
    .select({
      url: bridgeConnections.webhookUrl,
      subscribed: bridgeConnections.subscribedEvents,
      mode: conversations.mode,
    })
    .from(conversations)
    .innerJoin(bridgeConnections, eq(bridgeConnections.id, conversations.connectionId))
    .where(eq(conversations.id, input.conversationId));
  if (!target?.url || target.mode === "eval") return 0;
  const subscribed = new Set(target.subscribed);
  const due = input.at ?? new Date();
  const deliveries = rows
    .filter((r) => subscribed.has(r.type))
    .map((r) => ({
      id: newId("dlv"),
      workspaceId: currentWorkspace,
      connectionId: r.connectionId,
      conversationId: r.conversationId,
      outboxEventId: r.id,
      seq: r.seq,
      ephemeral: r.ephemeral,
      attempt: 1,
      status: "pending",
      nextAttemptAt: due,
    }));
  if (deliveries.length > 0) await tx.insert(webhookDeliveries).values(deliveries);
  return deliveries.length;
}

export async function updateEndUser(
  tx: Tx,
  endUserId: string,
  change: { vars?: Record<string, Json>; attributes?: Record<string, Json> },
): Promise<void> {
  if (!change.vars && !change.attributes) return;
  await tx
    .update(endUsers)
    .set({
      ...(change.vars ? { vars: change.vars } : {}),
      ...(change.attributes ? { attributes: change.attributes } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(endUsers.id, endUserId));
}

export async function recordTurnProgress(tx: Tx, turnId: string, stepCount: number): Promise<void> {
  await tx.update(turns).set({ stepCount, updatedAt: sql`now()` }).where(eq(turns.id, turnId));
}

/** Ends a turn and marks its events processed. */
export async function finishTurn(
  tx: Tx,
  input: {
    turnId: string;
    status: "completed" | "waiting" | "handed_off" | "ended" | "failed";
    stepCount: number;
    error?: Record<string, Json>;
  },
): Promise<void> {
  await tx
    .update(turns)
    .set({
      status: input.status,
      stepCount: input.stepCount,
      endedAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(input.error ? { error: input.error } : {}),
    })
    .where(eq(turns.id, input.turnId));
  await tx
    .update(inboundEvents)
    .set({ processedAt: sql`now()` })
    .where(and(eq(inboundEvents.turnId, input.turnId), isNull(inboundEvents.processedAt)));
}

/**
 * Appends an inbound event with the conversation's next inbound seq (the janitor's `timeout`; the
 * Bridge API uses the same path in 4.5). Not fenced: the inbox is open to every writer.
 */
export async function appendInboundEvent(
  tx: Tx,
  input: { conversationId: string; kind: string; payload: Record<string, Json> },
): Promise<{ id: string; seq: number }> {
  const [conv] = await tx
    .update(conversations)
    .set({ nextInSeq: sql`${conversations.nextInSeq} + 1` })
    .where(eq(conversations.id, input.conversationId))
    .returning({
      seq: sql<number>`(${conversations.nextInSeq} - 1)::bigint`.mapWith(Number),
      connectionId: conversations.connectionId,
    });
  if (!conv) throw new AppError("not_found", {}, { detail: `Conversation ${input.conversationId} was not found.` });
  const id = newId("evt");
  await tx.insert(inboundEvents).values({
    id,
    workspaceId: currentWorkspace,
    connectionId: conv.connectionId,
    conversationId: input.conversationId,
    seq: conv.seq,
    kind: input.kind,
    payload: input.payload,
  });
  return { id, seq: conv.seq };
}
