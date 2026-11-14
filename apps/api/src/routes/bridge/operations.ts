import { eventIdOf, requestFingerprint, signatureHeader, toBridgeEvent } from "@wakeel/bridge";
import { API_LIMITS } from "@wakeel/config";
import {
  Accepted,
  AppError,
  ATTEMPT_HEADER,
  type BridgeConnection,
  type BridgeDelivery,
  EVENT_ID_HEADER,
  type Json,
  newId,
  SIGNATURE_HEADER,
} from "@wakeel/contracts";
import {
  type DeliveryCursor,
  type DeliverySummary,
  findConversation,
  findInboundByIdempotencyKey,
  getConnectionDetail,
  getConversation,
  getEndUserById,
  inboundForPlannedTurn,
  insertInbound,
  listConversationEvents,
  listDeliveries,
  openSigningSecrets,
  replayDelivery,
  type StoredInbound,
} from "@wakeel/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BridgeContext } from "./auth";
import { type BridgeDeps, ExternalId } from "./index";
import { conversationView } from "./views";

/**
 * The rest of the Bridge API (task 5.3, ADR-029): listConversationEvents, endConversation,
 * submitToolResult, listDeliveries, replayDelivery, getConnection and testWebhook.
 */

const PREFIX = "/v1/bridge";
const Limit = z.coerce.number().int().min(1).max(API_LIMITS.pageSizeMax).default(API_LIMITS.pageSizeDefault);
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), limit: Limit });
const DeliveriesQuery = z.object({
  status: z.enum(["pending", "delivered", "failed", "dead"]).optional(),
  limit: Limit,
  cursor: z.string().optional(),
});
const ToolResultBody = z.object({
  toolCallId: z.string().min(1).max(200),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().max(4_000) }).optional(),
});
const EventIdParam = z.string().regex(/^evt_[0-9a-z]{26}$/);

/** The test event's stand-in conversation and user (ADR-029 §4): it belongs to no real conversation. */
export const TEST_CONVERSATION = { id: `conv_${"0".repeat(26)}`, externalId: "wakeel_test" } as const;
export const TEST_USER = { id: `eu_${"0".repeat(26)}`, externalId: "wakeel_test" } as const;

const externalIdOf = (request: FastifyRequest) =>
  ExternalId.parse((request.params as { externalConversationId: string }).externalConversationId);

export async function bridgeOperationRoutes(
  app: FastifyInstance,
  deps: BridgeDeps,
  auth: (request: FastifyRequest) => Promise<BridgeContext>,
): Promise<void> {
  app.get(`${PREFIX}/conversations/:externalConversationId/events`, async (request) => {
    const ctx = await auth(request);
    const externalId = externalIdOf(request);
    const query = EventsQuery.parse(request.query);
    return deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const conv = await findConversation(tx, ctx.connection.id, externalId);
      if (!conv) throw new AppError("not_found");
      const user = await getEndUserById(tx, conv.endUserId);
      const rows = await listConversationEvents(tx, conv.id, { afterSeq: query.after, limit: query.limit });
      return {
        data: rows.map((row) =>
          toBridgeEvent(row, {
            connectionId: ctx.connection.id,
            botId: ctx.connection.botId,
            conversation: { id: conv.id, externalId: conv.externalId },
            user: { id: user.id, externalId: user.externalId },
          }),
        ),
      };
    });
  });

  app.post(`${PREFIX}/conversations/:externalConversationId/end`, async (request) => {
    const ctx = await auth(request);
    const externalId = externalIdOf(request);
    const event = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const conv = await findConversation(tx, ctx.connection.id, externalId);
      if (!conv) throw new AppError("not_found");
      return insertInbound(tx, { conversationId: conv.id, kind: "end", payload: { turnId: newId("turn") } });
    });
    // Through the inbox like every state change (ADR-029 §1); answer once the turn has run.
    await waitForTurn(deps, ctx, event, API_LIMITS.waitSecondsMax);
    return deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const conv = await findConversation(tx, ctx.connection.id, externalId);
      if (!conv) throw new AppError("not_found");
      return conversationView(conv, await getEndUserById(tx, conv.endUserId));
    });
  });

  app.post(`${PREFIX}/conversations/:externalConversationId/tool-results`, async (request, reply) => {
    const ctx = await auth(request);
    const externalId = externalIdOf(request);
    const body = ToolResultBody.parse(request.body);
    const keyHeader = request.headers["idempotency-key"];
    const idempotencyKey = keyHeader === undefined ? undefined : z.string().min(1).max(255).parse(keyHeader);
    const fingerprint = requestFingerprint("submitToolResult", body);
    const event = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      if (idempotencyKey) {
        const first = await findInboundByIdempotencyKey(tx, ctx.connection.id, idempotencyKey);
        if (first) {
          if (first.payload["fingerprint"] !== fingerprint) throw new AppError("idempotency_mismatch");
          return first;
        }
      }
      const found = await findConversation(tx, ctx.connection.id, externalId);
      if (!found) throw new AppError("not_found");
      const conv = await getConversation(tx, found.id);
      const wait = conv.state.wait;
      if (conv.state.status !== "waiting_external" || wait?.kind !== "tool" || wait.toolCallId !== body.toolCallId)
        throw new AppError("tool_call_not_pending");
      const turnId = newId("turn");
      const response: Accepted = { conversationId: conv.id, turnId, status: "queued" };
      return insertInbound(tx, {
        conversationId: conv.id,
        kind: "tool_result",
        payload: {
          toolCallId: body.toolCallId,
          ...(body.result !== undefined ? { result: body.result as Json } : {}),
          ...(body.error ? { error: body.error } : {}),
          turnId,
          fingerprint,
          response: response as unknown as Json,
        },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    });
    if (!event.processedAt) await deps.enqueueTurn(event.conversationId);
    return reply.code(202).send(Accepted.parse(event.payload["response"]));
  });

  app.get(`${PREFIX}/deliveries`, async (request) => {
    const ctx = await auth(request);
    const query = DeliveriesQuery.parse(request.query);
    const before = query.cursor === undefined ? undefined : decodeDeliveryCursor(query.cursor);
    const rows = await deps.db.withWorkspace(ctx.workspaceId, (tx) =>
      listDeliveries(tx, ctx.connection.id, {
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
  });

  app.post(`${PREFIX}/deliveries/:eventId/replay`, async (request, reply) => {
    const ctx = await auth(request);
    const parsed = EventIdParam.safeParse((request.params as { eventId: string }).eventId);
    if (!parsed.success) throw new AppError("not_found");
    // An event id is its outbox row's ULID under the `evt_` prefix (envelope.ts).
    const outboxEventId = `out_${parsed.data.slice("evt_".length)}`;
    const replayed = await deps.db.withWorkspace(ctx.workspaceId, (tx) =>
      replayDelivery(tx, { connectionId: ctx.connection.id, outboxEventId, at: deps.now() }),
    );
    if (replayed.result === "not_found") throw new AppError("not_found");
    if (replayed.result !== "queued") throw new AppError("delivery_not_replayable");
    await deps.enqueueWebhook(replayed.conversationId);
    return reply.code(202).send();
  });

  app.get(`${PREFIX}/connection`, async (request) => {
    const ctx = await auth(request);
    const detail = await deps.db.withWorkspace(ctx.workspaceId, (tx) => getConnectionDetail(tx, ctx.connection.id));
    if (!detail) throw new AppError("not_found");
    const view: BridgeConnection = {
      id: detail.id,
      botId: detail.botId,
      name: detail.name,
      target: detail.target,
      status: detail.status,
      webhookUrl: detail.webhookUrl,
      subscribedEvents: detail.subscribedEvents,
    };
    return view;
  });

  app.post(`${PREFIX}/connection/test`, async (request) => {
    const ctx = await auth(request);
    const detail = await deps.db.withWorkspace(ctx.workspaceId, (tx) => getConnectionDetail(tx, ctx.connection.id));
    if (!detail) throw new AppError("not_found");
    const secrets = detail.signingSecrets.length
      ? openSigningSecrets(deps.keyring, {
          workspaceId: ctx.workspaceId,
          connectionId: detail.id,
          stored: detail.signingSecrets,
        })
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
      workspaceId: ctx.workspaceId,
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
  });
}

/** Holds until the event's turn is done or `seconds` pass (the `wait` pattern, §9.3). */
async function waitForTurn(deps: BridgeDeps, ctx: BridgeContext, event: StoredInbound, seconds: number) {
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const stop = await deps.signals.listen(`turn-done:${event.conversationId}:${event.seq}`, () => done());
  try {
    await deps.enqueueTurn(event.conversationId);
    const turnId = event.payload["turnId"] as string;
    const processed = async () =>
      deps.db.withWorkspace(ctx.workspaceId, async (tx) => (await inboundForPlannedTurn(tx, turnId))?.processedAt);
    if (!(await processed())) await Promise.race([finished, (deps.sleep ?? sleep)(seconds * 1000)]);
  } finally {
    await stop();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

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
