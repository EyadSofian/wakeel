import { requestFingerprint, toBridgeEvent } from "@wakeel/bridge";
import { API_LIMITS } from "@wakeel/config";
import { Accepted, AppError, type BridgeConnection, type Json, newId } from "@wakeel/contracts";
import {
  findConversation,
  findInboundByIdempotencyKey,
  getConnectionDetail,
  getConversation,
  getEndUserById,
  inboundForPlannedTurn,
  insertInbound,
  listConversationEvents,
  type StoredInbound,
} from "@wakeel/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BridgeContext } from "./auth";
import { type BridgeDeps, ExternalId } from "./index";
import { conversationView } from "./views";
import { deliveriesPage, replay, sendTestEvent } from "./webhook-tools";

/**
 * The rest of the Bridge API: listConversationEvents, endConversation, submitToolResult,
 * listDeliveries, replayDelivery, getConnection and testWebhook (task 5.3, ADR-029), and
 * releaseHandoff (task 5.4).
 */

const PREFIX = "/v1/bridge";
const Limit = z.coerce.number().int().min(1).max(API_LIMITS.pageSizeMax).default(API_LIMITS.pageSizeDefault);
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), limit: Limit });
const ToolResultBody = z.object({
  toolCallId: z.string().min(1).max(200),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().max(4_000) }).optional(),
});
const ReleaseBody = z.object({ note: z.string().max(2_000).optional() }).default({});

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

  app.post(`${PREFIX}/conversations/:externalConversationId/handoff/release`, async (request) => {
    const ctx = await auth(request);
    const externalId = externalIdOf(request);
    const body = ReleaseBody.parse(request.body ?? {});
    const event = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const conv = await findConversation(tx, ctx.connection.id, externalId);
      if (!conv) throw new AppError("not_found");
      if (conv.status !== "handed_off") throw new AppError("not_handed_off");
      // The agent's note reaches the bot as `event.payload.note` (OpenAPI releaseHandoff).
      return insertInbound(tx, {
        conversationId: conv.id,
        kind: "handoff_release",
        payload: { turnId: newId("turn"), ...(body.note ? { note: body.note } : {}) },
      });
    });
    // Like endConversation: through the inbox, then answer once the turn has run (§9.4).
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
    return deliveriesPage(deps.db, ctx.workspaceId, ctx.connection.id, request.query);
  });

  app.post(`${PREFIX}/deliveries/:eventId/replay`, async (request, reply) => {
    const ctx = await auth(request);
    await replay(deps, ctx.workspaceId, ctx.connection.id, (request.params as { eventId: string }).eventId);
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
    return sendTestEvent(deps, ctx.workspaceId, detail);
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
