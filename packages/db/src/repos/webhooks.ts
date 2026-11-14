import { type Json, newId } from "@wakeel/contracts";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { type Keyring, open, seal } from "../crypto";
import { bridgeConnections, conversations, endUsers, outboxEvents, webhookDeliveries } from "../schema/runtime";
import { currentWorkspace } from "./scope";

/**
 * Webhook delivery rows (task 5.2, architecture §9.2, ADR-005, ADR-028). One row per attempt; the
 * stream of a conversation is its pending ordered rows by `seq`, and only the lowest is sent.
 * Every call runs inside `withWorkspace`.
 */

/** Twenty consecutive dead events turn a connection off (§9.2). */
export const DEAD_EVENTS_TO_DISABLE = 20;

/**
 * A signing secret as stored in `bridge_connections.signing_secrets`: envelope-encrypted (task 1.5)
 * with the workspace and connection as additional data, so a ciphertext copied to another row or
 * workspace does not open.
 */
export interface StoredSigningSecret {
  ciphertext: string;
  keyVersion: number;
}

const secretAad = (workspaceId: string, connectionId: string) => `bridge_connections:${workspaceId}:${connectionId}`;

/** Replaces a connection's signing secrets (newest first). The plaintexts are never stored. */
export async function setSigningSecrets(
  tx: Tx,
  keyring: Keyring,
  input: { workspaceId: string; connectionId: string; secrets: readonly string[] },
): Promise<void> {
  const stored: StoredSigningSecret[] = input.secrets.map((secret) => {
    const sealed = seal(keyring, secret, secretAad(input.workspaceId, input.connectionId));
    return { ciphertext: sealed.ciphertext.toString("base64"), keyVersion: sealed.keyVersion };
  });
  await tx
    .update(bridgeConnections)
    .set({ signingSecrets: stored, updatedAt: sql`now()` })
    .where(eq(bridgeConnections.id, input.connectionId));
}

/** Opens a connection's signing secrets, newest first. Throws `DecryptError` on a wrong key or row. */
export function openSigningSecrets(
  keyring: Keyring,
  input: { workspaceId: string; connectionId: string; stored: readonly StoredSigningSecret[] },
): string[] {
  return input.stored.map((s) =>
    open(
      keyring,
      { ciphertext: Buffer.from(s.ciphertext, "base64"), keyVersion: s.keyVersion },
      secretAad(input.workspaceId, input.connectionId),
    ).toString("utf8"),
  );
}

/** What the delivery worker needs to sign and send one conversation's events. */
export interface DeliveryStream {
  connection: {
    id: string;
    botId: string;
    status: "active" | "paused" | "disabled";
    webhookUrl: string | null;
    /** Sealed signing secrets, newest first (two during a rotation); open with `openSigningSecrets`. */
    signingSecrets: StoredSigningSecret[];
  };
  conversation: { id: string; externalId: string };
  user: { id: string; externalId: string };
  /** Pending ephemeral deliveries: sent once, out of order. */
  ephemeral: PendingDelivery[];
  /** The lowest-seq pending ordered delivery: the only ordered one that may be sent. */
  head: PendingDelivery | undefined;
}

export interface PendingDelivery {
  id: string;
  attempt: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  event: {
    id: string;
    seq: number | null;
    type: string;
    payload: Record<string, Json>;
    ephemeral: boolean;
    createdAt: Date;
  };
}

/** Loads a conversation's delivery stream, or `undefined` if the conversation is gone. */
export async function loadDeliveryStream(tx: Tx, conversationId: string): Promise<DeliveryStream | undefined> {
  const [row] = await tx
    .select({
      connectionId: bridgeConnections.id,
      botId: bridgeConnections.botId,
      status: bridgeConnections.status,
      webhookUrl: bridgeConnections.webhookUrl,
      signingSecrets: bridgeConnections.signingSecrets,
      conversationExternalId: conversations.externalId,
      userId: endUsers.id,
      userExternalId: endUsers.externalId,
    })
    .from(conversations)
    .innerJoin(bridgeConnections, eq(bridgeConnections.id, conversations.connectionId))
    .innerJoin(endUsers, eq(endUsers.id, conversations.endUserId))
    .where(eq(conversations.id, conversationId));
  if (!row) return undefined;

  const pending = (ephemeral: boolean) =>
    tx
      .select({ d: webhookDeliveries, o: outboxEvents })
      .from(webhookDeliveries)
      .innerJoin(outboxEvents, eq(outboxEvents.id, webhookDeliveries.outboxEventId))
      .where(
        and(
          eq(webhookDeliveries.conversationId, conversationId),
          eq(webhookDeliveries.status, "pending"),
          eq(webhookDeliveries.ephemeral, ephemeral),
        ),
      )
      .orderBy(asc(webhookDeliveries.seq), asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id));
  const ephemeral = await pending(true);
  const [head] = await pending(false).limit(1);

  return {
    connection: {
      id: row.connectionId,
      botId: row.botId,
      status: row.status as DeliveryStream["connection"]["status"],
      webhookUrl: row.webhookUrl,
      signingSecrets: row.signingSecrets as StoredSigningSecret[],
    },
    conversation: { id: conversationId, externalId: row.conversationExternalId },
    user: { id: row.userId, externalId: row.userExternalId },
    ephemeral: ephemeral.map(toPending),
    head: head ? toPending(head) : undefined,
  };
}

const toPending = (r: {
  d: typeof webhookDeliveries.$inferSelect;
  o: typeof outboxEvents.$inferSelect;
}): PendingDelivery => ({
  id: r.d.id,
  attempt: r.d.attempt,
  nextAttemptAt: r.d.nextAttemptAt,
  leaseUntil: r.d.leaseUntil,
  event: {
    id: r.o.id,
    seq: r.o.seq,
    type: r.o.type,
    payload: r.o.payload as Record<string, Json>,
    ephemeral: r.o.ephemeral,
    createdAt: r.o.createdAt,
  },
});

/**
 * Leases a pending delivery for one send. False when another sender holds it or it is no longer
 * pending: the caller then leaves the stream alone (ADR-028 §3).
 */
export async function claimDelivery(tx: Tx, deliveryId: string, now: Date, leaseUntil: Date): Promise<boolean> {
  const rows = await tx
    .update(webhookDeliveries)
    .set({ leaseUntil })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.status, "pending"),
        or(isNull(webhookDeliveries.leaseUntil), lt(webhookDeliveries.leaseUntil, now)),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.length === 1;
}

export interface AttemptOutcome {
  status: "delivered" | "failed" | "dead";
  attemptedAt: Date;
  durationMs?: number;
  responseStatus?: number;
  error?: { code: string; detail?: string };
  /** For a failed ordered attempt with schedule left: when attempt n+1 is due. */
  retryAt?: Date;
}

/**
 * Records the outcome of a leased attempt and, for a failure with schedule left, adds the next
 * attempt. Keeps the connection's dead count: reset by a delivery, raised by a dead event, and at
 * `DEAD_EVENTS_TO_DISABLE` the connection is disabled. Returns whether this call disabled it, so the
 * caller can write the audit entry in the same transaction.
 */
export async function recordAttempt(
  tx: Tx,
  deliveryId: string,
  outcome: AttemptOutcome,
): Promise<{ disabled: boolean; consecutiveDead: number }> {
  const [row] = await tx
    .update(webhookDeliveries)
    .set({
      status: outcome.status,
      attemptedAt: outcome.attemptedAt,
      leaseUntil: null,
      durationMs: outcome.durationMs ?? null,
      responseStatus: outcome.responseStatus ?? null,
      error: outcome.error ?? null,
    })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, "pending")))
    .returning();
  if (!row) throw new Error(`delivery ${deliveryId} is not pending`);

  if (outcome.status === "failed" && outcome.retryAt) {
    await tx.insert(webhookDeliveries).values({
      id: newId("dlv"),
      workspaceId: currentWorkspace,
      connectionId: row.connectionId,
      conversationId: row.conversationId,
      outboxEventId: row.outboxEventId,
      seq: row.seq,
      ephemeral: row.ephemeral,
      attempt: row.attempt + 1,
      status: "pending",
      nextAttemptAt: outcome.retryAt,
    });
  }

  // Ephemeral events are best-effort: they never move the dead count.
  if (row.ephemeral || outcome.status === "failed") return { disabled: false, consecutiveDead: -1 };
  const [connection] = await tx
    .update(bridgeConnections)
    .set(
      outcome.status === "delivered"
        ? { consecutiveDead: 0 }
        : {
            consecutiveDead: sql`${bridgeConnections.consecutiveDead} + 1`,
            status: sql`case when ${bridgeConnections.consecutiveDead} + 1 >= ${DEAD_EVENTS_TO_DISABLE} then 'disabled' else ${bridgeConnections.status} end`,
            updatedAt: sql`now()`,
          },
    )
    .where(eq(bridgeConnections.id, row.connectionId))
    .returning({ consecutiveDead: bridgeConnections.consecutiveDead, status: bridgeConnections.status });
  const consecutiveDead = connection?.consecutiveDead ?? 0;
  return {
    disabled: outcome.status === "dead" && consecutiveDead === DEAD_EVENTS_TO_DISABLE,
    consecutiveDead,
  };
}
