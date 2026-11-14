import { eventIdOf, signatureHeader, toBridgeEvent, type WebhookSender } from "@wakeel/bridge";
import { API_LIMITS } from "@wakeel/config";
import {
  AppError,
  ATTEMPT_HEADER,
  type BridgeDelivery,
  EVENT_ID_HEADER,
  newId,
  SIGNATURE_HEADER,
  type WebhookTestResult,
} from "@wakeel/contracts";
import {
  type ConnectionDetail,
  type Database,
  type DeliveryCursor,
  type DeliverySummary,
  type Keyring,
  listDeliveries,
  openSigningSecrets,
  replayDelivery,
} from "@wakeel/db";
import { z } from "zod";

/**
 * Webhook tools shared by the Bridge API (ADR-029) and the Studio's Connections screens (ADR-030):
 * the delivery list, replay and the signed test event. One implementation, so both behave the same.
 */

const DeliveriesQuery = z.object({
  status: z.enum(["pending", "delivered", "failed", "dead"]).optional(),
  limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSizeMax).default(API_LIMITS.pageSizeDefault),
  cursor: z.string().optional(),
});
const EventIdParam = z.string().regex(/^evt_[0-9a-z]{26}$/);

/** The test event's stand-in conversation and user (ADR-029 §4): it belongs to no real conversation. */
export const TEST_CONVERSATION = { id: `conv_${"0".repeat(26)}`, externalId: "wakeel_test" } as const;
export const TEST_USER = { id: `eu_${"0".repeat(26)}`, externalId: "wakeel_test" } as const;

/** One page of a connection's deliveries, one item per event (ADR-029 §5). */
export async function deliveriesPage(db: Database, workspaceId: string, connectionId: string, rawQuery: unknown) {
  const query = DeliveriesQuery.parse(rawQuery);
  const before = query.cursor === undefined ? undefined : decodeDeliveryCursor(query.cursor);
  const rows = await db.withWorkspace(workspaceId, (tx) =>
    listDeliveries(tx, connectionId, {
      limit: query.limit + 1,
      ...(query.status ? { status: query.status } : {}),
      ...(before ? { before } : {}),
    }),
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(deliveryView),
    nextCursor: rows.length > query.limit && last ? encodeDeliveryCursor(last.cursor) : null,
  };
}

/** Re-queues a dead or failed event once (ADR-029 §3) and wakes its stream. */
export async function replay(
  deps: { db: Database; now: () => Date; enqueueWebhook(conversationId: string): Promise<void> },
  workspaceId: string,
  connectionId: string,
  rawEventId: string,
): Promise<void> {
  const parsed = EventIdParam.safeParse(rawEventId);
  if (!parsed.success) throw new AppError("not_found");
  // An event id is its outbox row's ULID under the `evt_` prefix (envelope.ts).
  const outboxEventId = `out_${parsed.data.slice("evt_".length)}`;
  const replayed = await deps.db.withWorkspace(workspaceId, (tx) =>
    replayDelivery(tx, { connectionId, outboxEventId, at: deps.now() }),
  );
  if (replayed.result === "not_found") throw new AppError("not_found");
  if (replayed.result !== "queued") throw new AppError("delivery_not_replayable");
  await deps.enqueueWebhook(replayed.conversationId);
}

/** Sends a signed, ephemeral `turn.completed` for the test conversation and reports the answer (ADR-029 §4). */
export async function sendTestEvent(
  deps: { sender: WebhookSender; keyring: Keyring; now: () => Date },
  workspaceId: string,
  detail: ConnectionDetail,
): Promise<WebhookTestResult> {
  const secrets = detail.signingSecrets.length
    ? openSigningSecrets(deps.keyring, { workspaceId, connectionId: detail.id, stored: detail.signingSecrets })
    : [];
  if (!detail.webhookUrl || secrets.length === 0)
    return { delivered: false, durationMs: 0, error: "webhook_secret_missing" };

  const now = deps.now();
  const event = toBridgeEvent(
    {
      id: newId("out"),
      seq: null,
      type: "turn.completed",
      payload: { data: { status: "completed", messageCount: 0, durationMs: 0 } },
      ephemeral: true,
      createdAt: now,
    },
    { connectionId: detail.id, botId: detail.botId, conversation: TEST_CONVERSATION, user: TEST_USER },
  );
  const body = JSON.stringify(event);
  const started = Date.now();
  const result = await deps.sender.send({
    workspaceId,
    url: detail.webhookUrl,
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Wakeel-Webhooks/1",
      [SIGNATURE_HEADER]: signatureHeader(secrets, Math.floor(now.getTime() / 1000), body),
      [EVENT_ID_HEADER]: event.id,
      [ATTEMPT_HEADER]: "1",
    },
  });
  const durationMs = Date.now() - started;
  if (result.kind === "refused") return { delivered: false, durationMs, error: result.code };
  const delivered = result.status >= 200 && result.status < 300;
  return {
    delivered,
    statusCode: result.status,
    durationMs,
    ...(delivered
      ? {}
      : { error: result.status >= 300 && result.status < 400 ? "webhook_redirected" : "webhook_rejected" }),
  };
}

function deliveryView(d: DeliverySummary): BridgeDelivery {
  return {
    eventId: eventIdOf(d.outboxEventId),
    eventType: d.eventType,
    conversationId: d.conversationId,
    ...(d.seq === null ? {} : { seq: d.seq }),
    status: d.status,
    attempt: d.attempt,
    nextAttemptAt: d.nextAttemptAt ? d.nextAttemptAt.toISOString() : null,
    responseStatus: d.responseStatus,
    error: d.error?.code ?? null,
  };
}

const encodeDeliveryCursor = (d: DeliveryCursor) =>
  Buffer.from(`d:${d.createdMicros}:${d.seq}:${d.outboxEventId}`).toString("base64url");

function decodeDeliveryCursor(cursor: string): DeliveryCursor {
  const match = /^d:(\d{1,19}):(\d{1,15}):(out_[0-9a-z]{26})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match)
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "cursor", code: "invalid", message: "Use a nextCursor this API returned" }] },
    );
  return { createdMicros: BigInt(match[1] as string), seq: Number(match[2]), outboxEventId: match[3] as string };
}
