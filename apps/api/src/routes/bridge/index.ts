import {
  externalMessageKey,
  requestFingerprint,
  sseFrame,
  toBridgeEvent,
  toMessage,
  type WebhookSender,
} from "@wakeel/bridge";
import { API_LIMITS } from "@wakeel/config";
import {
  Accepted,
  AppError,
  emptyState,
  type Json,
  LIMITS,
  newId,
  SendEventRequest,
  SendMessageRequest,
  TurnId,
  UserData,
} from "@wakeel/contracts";
import {
  type Database,
  ensureConversation,
  findConversation,
  findEndUser,
  findInboundByIdempotencyKey,
  getBridgeConversation,
  getEndUserById,
  inboundForPlannedTurn,
  insertInbound,
  insertUserMessage,
  type Keyring,
  listTranscript,
  listTurnSpans,
  outboxOfTurn,
  type StoredInbound,
  upsertEndUser,
} from "@wakeel/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type BridgeContext, requireBridgeKey } from "./auth";
import { bridgeOperationRoutes } from "./operations";
import type { Signals } from "./signals";
import { conversationView, turnResult, userPatch, userView } from "./views";

export interface BridgeDeps {
  db: Database;
  signals: Signals;
  /** Adds a `turn` job for the conversation (BullMQ, `jobId` = conversation id; §4.2 step 3). */
  enqueueTurn(conversationId: string): Promise<void>;
  /** Adds a `webhook` job for the conversation (ADR-028 §4), after a replay (ADR-029 §3). */
  enqueueWebhook(conversationId: string): Promise<void>;
  /** Sends `testWebhook`'s event through egress (ADR-029 §4). */
  sender: WebhookSender;
  /** Opens the connection's signing secrets for `testWebhook`. */
  keyring: Keyring;
  now: () => Date;
  /** Waits out `?wait=`; tests pass one that does not sleep on real time. */
  sleep?: (ms: number) => Promise<void>;
}

const PREFIX = "/v1/bridge";
/** A caller's conversation id in a path (OpenAPI pattern). */
export const ExternalId = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._~:-]+$/, "Use letters, digits and . _ ~ : -");
const WaitQuery = z.object({ wait: z.coerce.number().int().min(1).max(API_LIMITS.waitSecondsMax).optional() });
const IdempotencyKey = z.string().min(1).max(255);
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(API_LIMITS.pageSizeMax).default(API_LIMITS.pageSizeDefault),
  cursor: z.string().optional(),
});
const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** The `wait`/SSE hold for a request that asked for SSE without `wait`. */
const SSE_DEFAULT_SECONDS = API_LIMITS.waitSecondsMax;
/** SSE readers also poll, in case a notification was missed. */
const SSE_POLL_MS = 1_000;

/**
 * The Bridge API under `/v1/bridge`: the inbound half (task 4.5, architecture §4.2, §9.1, §9.3,
 * ADR-005: sendMessage, sendEvent, updateUser, getConversation, listMessages and getTurn), and the
 * rest (task 5.3, ADR-029) in `operations.ts`.
 */
export async function bridgeRoutes(app: FastifyInstance, deps: BridgeDeps): Promise<void> {
  const auth = (request: FastifyRequest) => requireBridgeKey(deps.db, request, deps.now());
  await bridgeOperationRoutes(app, deps, auth);

  app.post(`${PREFIX}/conversations/:externalConversationId/messages`, async (request, reply) => {
    const ctx = await auth(request);
    return inbound(deps, ctx, request, reply, sendMessageInput(SendMessageRequest.parse(request.body)));
  });

  app.post(`${PREFIX}/conversations/:externalConversationId/events`, async (request, reply) => {
    const ctx = await auth(request);
    const body = SendEventRequest.parse(request.body);
    return inbound(deps, ctx, request, reply, {
      operation: "sendEvent",
      body,
      userId: body.userId,
      user: body.user,
      kind: "event",
      payload: { name: body.name, payload: body.payload },
    });
  });

  app.get(`${PREFIX}/conversations/:externalConversationId`, async (request) => {
    const ctx = await auth(request);
    const externalId = ExternalId.parse((request.params as { externalConversationId: string }).externalConversationId);
    return deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const conv = await findConversation(tx, ctx.connection.id, externalId);
      if (!conv) throw new AppError("not_found");
      return conversationView(conv, await getEndUserById(tx, conv.endUserId));
    });
  });

  app.get(`${PREFIX}/conversations/:externalConversationId/messages`, async (request) => {
    const ctx = await auth(request);
    const externalId = ExternalId.parse((request.params as { externalConversationId: string }).externalConversationId);
    const query = ListQuery.parse(request.query);
    const afterSeq = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    return deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const conv = await findConversation(tx, ctx.connection.id, externalId);
      if (!conv) throw new AppError("not_found");
      const rows = await listTranscript(tx, conv.id, {
        limit: query.limit + 1,
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      const page = rows.slice(0, query.limit);
      return {
        data: page.map((m) => toMessage(m, conv.id)),
        nextCursor: rows.length > query.limit ? encodeCursor((page.at(-1) as { seq: number }).seq) : null,
      };
    });
  });

  app.put(`${PREFIX}/users/:externalUserId`, async (request) => {
    const ctx = await auth(request);
    const externalId = z
      .string()
      .min(1)
      .max(255)
      .parse((request.params as { externalUserId: string }).externalUserId);
    return updateUser(deps, ctx, externalId, UserData.parse(request.body));
  });

  app.get(`${PREFIX}/turns/:turnId`, async (request) => {
    const ctx = await auth(request);
    const parsed = TurnId.safeParse((request.params as { turnId: string }).turnId);
    if (!parsed.success) throw new AppError("not_found");
    return deps.db.withWorkspace(ctx.workspaceId, (tx) =>
      turnResult(tx, parsed.data, { connectionId: ctx.connection.id, botId: ctx.connection.botId }),
    );
  });
}

/** The inbound input for a `sendMessage` body, after its size limits (also used by the emulator). */
export function sendMessageInput(body: SendMessageRequest): InboundInput {
  if (body.message.type === "text" && bytes(body.message.text) > LIMITS.inboundTextBytes)
    throw new AppError("payload_too_large", { limit: "16 KB of message text" });
  if (body.metadata && bytes(body.metadata) > API_LIMITS.metadataBytes)
    throw new AppError("payload_too_large", { limit: "8 KB of metadata" });
  return {
    operation: "sendMessage",
    body,
    userId: body.userId,
    user: body.user,
    kind: "message",
    payload: {
      message: body.message as unknown as Json,
      ...(body.metadata ? { metadata: body.metadata } : {}),
      ...(body.externalMessageId ? { externalMessageId: body.externalMessageId } : {}),
    },
    message: {
      payload: body.message as unknown as Record<string, Json>,
      type: body.message.type,
      externalId: body.externalMessageId,
    },
  };
}

/** `updateUser` for a connection: merge the data into the end user, creating it on first use. */
export async function updateUser(deps: Pick<BridgeDeps, "db">, ctx: BridgeContext, externalId: string, data: UserData) {
  if (data.attributes && bytes(data.attributes) > LIMITS.userAttributesBytes)
    throw new AppError("payload_too_large", { limit: "16 KB of attributes" });
  const user = await deps.db.withWorkspace(ctx.workspaceId, (tx) =>
    upsertEndUser(tx, {
      connectionId: ctx.connection.id,
      botId: ctx.connection.botId,
      externalId,
      patch: userPatch(data),
    }),
  );
  return userView(user);
}

export interface InboundInput {
  /** Part of the idempotency fingerprint, so one key cannot be reused across operations. */
  operation: "sendMessage" | "sendEvent" | "runFrom";
  body: unknown;
  userId: string | undefined;
  user: UserData | undefined;
  /** `run_from` comes only from the Studio emulator routes (ADR-025). */
  kind: "message" | "event" | "run_from";
  /** The emulator's stream also carries the turn's spans (ADR-026); the public Bridge API never does. */
  streamSpans?: boolean;
  payload: Record<string, Json>;
  message?: { payload: Record<string, Json>; type: string; externalId: string | undefined };
  /** Forces the conversation's mode: the Studio's Test tab is builder traffic (ADR-030 §3). */
  mode?: "emulator";
  /** The conversation id, when it is not in the path (the Studio's Test tab). */
  externalConversationId?: string;
}

/**
 * The inbound path (§4.2): in one transaction, upsert the user and the conversation by their
 * external ids, refuse or replay a repeated `Idempotency-Key` (or `externalMessageId`), append the inbox event (and the user
 * message), then enqueue the turn and answer `202`, wait for the turn, or stream it.
 */
export async function inbound(
  deps: BridgeDeps,
  ctx: BridgeContext,
  request: FastifyRequest,
  reply: FastifyReply,
  input: InboundInput,
) {
  const externalId = ExternalId.parse(
    input.externalConversationId ?? (request.params as { externalConversationId: string }).externalConversationId,
  );
  const { wait } = WaitQuery.parse(request.query);
  const keyHeader = request.headers["idempotency-key"];
  // An explicit key wins; without one, `externalMessageId` de-duplicates the message (ADR-024).
  const externalMessageId = input.message?.externalId;
  const idempotencyKey =
    keyHeader !== undefined
      ? IdempotencyKey.parse(keyHeader)
      : externalMessageId !== undefined
        ? externalMessageKey(externalId, externalMessageId)
        : undefined;
  const fingerprint = requestFingerprint(input.operation, input.body);
  if (input.user?.attributes && bytes(input.user.attributes) > LIMITS.userAttributesBytes)
    throw new AppError("payload_too_large", { limit: "16 KB of attributes" });

  const record = async (): Promise<StoredInbound> =>
    deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      if (idempotencyKey) {
        const first = await findInboundByIdempotencyKey(tx, ctx.connection.id, idempotencyKey);
        if (first) {
          if (first.payload["fingerprint"] !== fingerprint) throw new AppError("idempotency_mismatch");
          return first;
        }
      }
      let conv = await findConversation(tx, ctx.connection.id, externalId);
      let userExternalId = input.userId;
      if (!conv && userExternalId === undefined)
        throw new AppError(
          "validation_failed",
          {},
          {
            errors: [
              { path: "userId", code: "required", message: "Send userId with the first message of a conversation" },
            ],
          },
        );
      if (conv && userExternalId === undefined) userExternalId = (await getEndUserById(tx, conv.endUserId)).externalId;
      const known = await findEndUser(tx, ctx.connection.id, userExternalId as string);
      const user =
        input.user || !known
          ? await upsertEndUser(tx, {
              connectionId: ctx.connection.id,
              botId: ctx.connection.botId,
              externalId: userExternalId as string,
              patch: userPatch(input.user ?? {}),
            })
          : known;
      if (conv && conv.endUserId !== user.id)
        throw new AppError(
          "validation_failed",
          {},
          { errors: [{ path: "userId", code: "user_mismatch", message: "This conversation belongs to another user" }] },
        );
      conv ??= await ensureConversation(tx, {
        connectionId: ctx.connection.id,
        botId: ctx.connection.botId,
        endUserId: user.id,
        externalId,
        // Draft connections run the draft and are not live traffic (§3.2, §13).
        mode: input.mode ?? (ctx.connection.target === "draft" ? "emulator" : "live"),
        state: emptyState() as unknown as Record<string, Json>,
        stateBytes: bytes(emptyState()),
      });
      const turnId = newId("turn");
      const stored = input.message
        ? await insertUserMessage(tx, {
            conversationId: conv.id,
            payload: input.message.payload,
            type: input.message.type,
            ...(input.message.externalId ? { externalId: input.message.externalId } : {}),
          })
        : undefined;
      const response: Accepted = {
        conversationId: conv.id,
        userId: user.id,
        ...(stored ? { messageId: stored.id } : {}),
        turnId,
        status: conv.status === "handed_off" ? "handed_off" : "queued",
      };
      return insertInbound(tx, {
        conversationId: conv.id,
        kind: input.kind,
        payload: { ...input.payload, turnId, fingerprint, response: response as unknown as Json },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    });

  let event: StoredInbound;
  try {
    event = await record();
  } catch (error) {
    // Two requests with the same new key at once: the loser replays the winner's.
    if (idempotencyKey && isUniqueViolation(error)) event = await record();
    else throw error;
  }
  const accepted = Accepted.parse(event.payload["response"]);

  const wantsStream = (request.headers.accept ?? "").includes("text/event-stream");
  if (wantsStream)
    return stream(deps, ctx, reply, event, accepted, wait ?? SSE_DEFAULT_SECONDS, input.streamSpans === true);
  if (wait === undefined) {
    if (!event.processedAt) await deps.enqueueTurn(event.conversationId);
    return reply.code(202).send(accepted);
  }

  // Listen before enqueueing, so the signal cannot be missed; then check it did not already happen.
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const stop = await deps.signals.listen(`turn-done:${event.conversationId}:${event.seq}`, () => done());
  try {
    if (!event.processedAt) await deps.enqueueTurn(event.conversationId);
    const processed = async () =>
      deps.db.withWorkspace(
        ctx.workspaceId,
        async (tx) => (await inboundForPlannedTurn(tx, accepted.turnId))?.processedAt,
      );
    if (!(await processed())) await Promise.race([finished, (deps.sleep ?? sleep)(wait * 1000)]);
    if (!(await processed())) return reply.code(202).send(accepted);
  } finally {
    await stop();
  }
  return deps.db.withWorkspace(ctx.workspaceId, (tx) =>
    turnResult(tx, accepted.turnId, { connectionId: ctx.connection.id, botId: ctx.connection.botId }),
  );
}

/**
 * SSE (§9.3): the turn's events as they are written, typing included, until `turn.completed` or the
 * hold runs out. Each frame is `event: <type>` and `data: <BridgeEvent>`.
 */
async function stream(
  deps: BridgeDeps,
  ctx: BridgeContext,
  reply: FastifyReply,
  event: StoredInbound,
  accepted: Accepted,
  seconds: number,
  withSpans = false,
) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-request-id": reply.request.id,
  });
  const seen = new Set<string>();
  const sentSpans = new Map<string, string>();
  let finished = false;
  let wake: () => void = () => {};
  const stop = await deps.signals.listen(`conversation-events:${event.conversationId}`, () => wake());
  const deadline = Date.now() + seconds * 1000;
  try {
    if (!event.processedAt) await deps.enqueueTurn(event.conversationId);
    while (!finished && Date.now() < deadline && !res.destroyed) {
      const rows = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
        const planned = await inboundForPlannedTurn(tx, accepted.turnId);
        const turnId = planned?.turnId ?? accepted.turnId;
        const conv = await getBridgeConversation(tx, event.conversationId);
        const user = conv ? await getEndUserById(tx, conv.endUserId) : undefined;
        const outbox = await outboxOfTurn(tx, event.conversationId, turnId, { ephemeral: true });
        const spans = withSpans ? await listTurnSpans(tx, turnId) : [];
        return { outbox, conv, user, spans };
      });
      // A span is sent when it appears and again whenever it changes (an open node or turn closing).
      for (const span of rows.spans) {
        const version = `${span.status}:${span.durationMs}:${JSON.stringify(span.attrs)}`;
        if (sentSpans.get(span.id) === version) continue;
        sentSpans.set(span.id, version);
        res.write(sseFrame("trace.span", span));
      }
      for (const row of rows.outbox) {
        if (seen.has(row.id) || !rows.conv || !rows.user) continue;
        seen.add(row.id);
        const bridgeEvent = toBridgeEvent(row, {
          connectionId: ctx.connection.id,
          botId: ctx.connection.botId,
          conversation: { id: rows.conv.id, externalId: rows.conv.externalId },
          user: { id: rows.user.id, externalId: rows.user.externalId },
        });
        res.write(sseFrame(bridgeEvent.type, bridgeEvent));
        if (bridgeEvent.type === "turn.completed") finished = true;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(SSE_POLL_MS, Math.max(0, deadline - Date.now())));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    await stop();
    res.end();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

const encodeCursor = (seq: number) => Buffer.from(`s:${seq}`).toString("base64url");
function decodeCursor(cursor: string): number {
  const match = /^s:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match)
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "cursor", code: "invalid", message: "Use a nextCursor this API returned" }] },
    );
  return Number(match[1]);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === "object") {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
