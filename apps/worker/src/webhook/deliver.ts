import { eventIdOf, type SendResult, signatureHeader, toBridgeEvent, type WebhookSender } from "@wakeel/bridge";
import { ATTEMPT_HEADER, EVENT_ID_HEADER, SIGNATURE_HEADER } from "@wakeel/contracts";
import {
  type AttemptOutcome,
  claimDelivery,
  type Database,
  type DeliveryStream,
  type Keyring,
  loadDeliveryStream,
  openSigningSecrets,
  type PendingDelivery,
  recordAttempt,
} from "@wakeel/db";
import type { ClockPort } from "@wakeel/engine";
import { audit, type Logger } from "@wakeel/telemetry";
import { retryAt } from "./schedule";

/**
 * The `webhook` queue's work for one conversation (architecture §9.2, ADR-005, ADR-028): pending
 * ephemeral events and replays once each (ADR-029 §3), then the ordered stream from its head, one
 * event at a time, until it is drained, waiting for a retry, held by another sender or by the
 * connection's status.
 */

export interface WebhookDeps {
  db: Database;
  logger: Logger;
  sender: WebhookSender;
  /** Opens the connection's signing secrets (task 1.5). */
  keyring: Keyring;
  clock?: ClockPort;
  /** [0, 1); the retry jitter. Tests pass a constant. */
  random?: () => number;
  /** Adds a delayed `webhook` job so the stream wakes when its head is due (ADR-028 §4). */
  scheduleWake(conversationId: string, deliveryId: string, at: Date): Promise<void>;
  /** How long a sender holds the head; longer than the 10 s request plus egress's margin. */
  leaseMs?: number;
  /** Events per job before the job hands over to a fresh one, so one busy stream cannot hog a slot. */
  maxPerJob?: number;
}

export interface DeliverResult {
  /** Requests sent to the receiver by this call (dropped and unsigned attempts are not counted). */
  sent: number;
  stopped: "drained" | "waiting" | "busy" | "paused" | "not_found" | "limit";
}

/** Ephemeral events older than this are dropped: a stale `typing` is worse than none (ADR-028 §5). */
export const EPHEMERAL_MAX_AGE_MS = 30_000;

const USER_AGENT = "Wakeel-Webhooks/1";

/** Delivers what is due for one conversation. Safe to run twice at once: the head is leased. */
export async function deliverConversation(deps: WebhookDeps, conversationId: string): Promise<DeliverResult> {
  const workspaceId = await deps.db.lookup.conversationWorkspace(conversationId);
  if (!workspaceId) return { sent: 0, stopped: "not_found" };
  const clock = deps.clock ?? { now: () => Date.now() };
  const log = deps.logger.child({ conversationId, workspaceId });
  const max = deps.maxPerJob ?? 100;
  let sent = 0;

  for (let i = 0; i < max; i++) {
    const stream = await deps.db.withWorkspace(workspaceId, (tx) => loadDeliveryStream(tx, conversationId));
    if (!stream) return { sent, stopped: "not_found" };
    // Paused and disabled connections hold their streams (ADR-028 §8).
    if (stream.connection.status !== "active") return { sent, stopped: "paused" };

    for (const delivery of stream.outOfBand) {
      if (await attempt(deps, clock, log, workspaceId, stream, delivery)) sent++;
    }

    const head = stream.head;
    if (!head) return { sent, stopped: "drained" };
    if (head.nextAttemptAt.getTime() > clock.now()) {
      await deps.scheduleWake(conversationId, head.id, head.nextAttemptAt);
      return { sent, stopped: "waiting" };
    }
    const result = await attempt(deps, clock, log, workspaceId, stream, head);
    if (result === undefined) return { sent, stopped: "busy" };
    if (result) sent++;
  }
  await deps.scheduleWake(conversationId, "next", new Date(clock.now()));
  return { sent, stopped: "limit" };
}

/**
 * One attempt at one delivery: lease it, sign and send it, record the outcome. Returns whether a
 * request went out, or `undefined` when another sender holds the delivery.
 */
async function attempt(
  deps: WebhookDeps,
  clock: ClockPort,
  log: Logger,
  workspaceId: string,
  stream: DeliveryStream,
  delivery: PendingDelivery,
): Promise<boolean | undefined> {
  const now = new Date(clock.now());
  const leaseUntil = new Date(now.getTime() + (deps.leaseMs ?? 30_000));
  const claimed = await deps.db.withWorkspace(workspaceId, (tx) => claimDelivery(tx, delivery.id, now, leaseUntil));
  if (!claimed) return undefined;

  const ephemeral = delivery.event.ephemeral;
  if (ephemeral && now.getTime() - delivery.event.createdAt.getTime() > EPHEMERAL_MAX_AGE_MS) {
    await record(deps, log, workspaceId, stream, delivery, {
      status: "dead",
      attemptedAt: now,
      error: { code: "webhook_stale" },
    });
    return false;
  }

  let secrets: string[];
  try {
    secrets = openSigningSecrets(deps.keyring, {
      workspaceId,
      connectionId: stream.connection.id,
      stored: stream.connection.signingSecrets,
    });
  } catch (err) {
    // A key that cannot open the row is a platform fault; it is logged and retried like any failure.
    log.error({ err, connectionId: stream.connection.id }, "signing secrets could not be opened");
    secrets = [];
  }
  const url = stream.connection.webhookUrl;
  if (!url || secrets.length === 0) {
    await record(
      deps,
      log,
      workspaceId,
      stream,
      delivery,
      failure(deps, delivery, now, {
        error: { code: "webhook_secret_missing", ...(url ? {} : { detail: "the connection has no webhook URL" }) },
      }),
    );
    return false;
  }

  const event = toBridgeEvent(delivery.event, {
    connectionId: stream.connection.id,
    botId: stream.connection.botId,
    conversation: stream.conversation,
    user: stream.user,
  });
  const body = JSON.stringify(event);
  const timestamp = Math.floor(now.getTime() / 1000);
  const started = clock.now();
  const result: SendResult = await deps.sender.send({
    workspaceId,
    url,
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      [SIGNATURE_HEADER]: signatureHeader(secrets, timestamp, body),
      [EVENT_ID_HEADER]: eventIdOf(delivery.event.id),
      [ATTEMPT_HEADER]: String(delivery.attempt),
    },
  });
  const timing = { attemptedAt: now, durationMs: Math.max(0, Math.round(clock.now() - started)) };

  let outcome: AttemptOutcome;
  if (result.kind === "response" && result.status >= 200 && result.status < 300) {
    outcome = { status: "delivered", ...timing, responseStatus: result.status };
  } else if (result.kind === "response") {
    const code = result.status >= 300 && result.status < 400 ? "webhook_redirected" : "webhook_rejected";
    outcome = failure(deps, delivery, now, { ...timing, responseStatus: result.status, error: { code } });
  } else {
    outcome = failure(deps, delivery, now, {
      ...timing,
      error: { code: result.code, ...(result.detail ? { detail: result.detail } : {}) },
    });
  }
  await record(deps, log, workspaceId, stream, delivery, outcome);
  return true;
}

/**
 * A failed attempt: retried on schedule if ordered, dead when the schedule is used up. Ephemeral
 * events and replays are one-offs and never retried.
 */
function failure(
  deps: WebhookDeps,
  delivery: PendingDelivery,
  now: Date,
  details: Omit<AttemptOutcome, "status" | "attemptedAt" | "retryAt">,
): AttemptOutcome {
  if (delivery.event.ephemeral || delivery.replay) return { status: "failed", attemptedAt: now, ...details };
  const next = retryAt(delivery.attempt, now, deps.random ?? Math.random);
  return next
    ? { status: "failed", attemptedAt: now, ...details, retryAt: next }
    : { status: "dead", attemptedAt: now, ...details };
}

/** Writes the outcome; the audit entry for a connection it disables goes in the same transaction. */
async function record(
  deps: WebhookDeps,
  log: Logger,
  workspaceId: string,
  stream: DeliveryStream,
  delivery: PendingDelivery,
  outcome: AttemptOutcome,
): Promise<void> {
  const { disabled, consecutiveDead } = await deps.db.withWorkspace(workspaceId, async (tx) => {
    const r = await recordAttempt(tx, delivery.id, outcome);
    if (r.disabled) {
      await audit(
        tx,
        { type: "system" },
        {
          action: "connection.disabled",
          target: { type: "connection", id: stream.connection.id },
          meta: { consecutiveDead: r.consecutiveDead },
        },
      );
    }
    return r;
  });
  const fields = {
    deliveryId: delivery.id,
    eventId: delivery.event.id,
    seq: delivery.event.seq,
    attempt: delivery.attempt,
    status: outcome.status,
    ...(outcome.responseStatus ? { responseStatus: outcome.responseStatus } : {}),
    ...(outcome.error ? { code: outcome.error.code } : {}),
  };
  if (outcome.status === "delivered") log.debug(fields, "webhook delivered");
  else log.info(fields, "webhook attempt failed");
  if (disabled) {
    log.error(
      { connectionId: stream.connection.id, consecutiveDead, code: "connection_disabled" },
      "connection disabled after repeated dead events",
    );
  }
}
