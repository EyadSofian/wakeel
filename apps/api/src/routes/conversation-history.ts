import {
  AppError,
  BotId,
  ConversationHistoryPage,
  ConversationHistoryQuery,
  ConversationId,
  ConversationTranscriptPage,
  IsoDateTime,
} from "@wakeel/contracts";
import { conversationTranscript, getBot, listConversationHistory } from "@wakeel/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission, type StudioDeps } from "../studio";

const cursorShape = z.object({ lastActivityAt: IsoDateTime, id: ConversationId });
const path = z.object({ botId: BotId, conversationId: ConversationId });
const transcriptPage = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional(),
});

function decodeCursor(value: string) {
  try {
    return cursorShape.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new AppError("validation_failed", {}, { detail: "Reload the conversation list to reset its cursor." });
  }
}

/** Read-only conversation history for Studio. */
export async function conversationHistoryRoutes(app: FastifyInstance, deps: StudioDeps) {
  const root = "/v1/workspaces/:workspaceId/bots/:botId/conversations";
  app.get(root, async (request, reply) => {
    const { workspaceId } = await requirePermission(deps, request, reply, "conversation.read");
    const { botId } = path.pick({ botId: true }).parse(request.params);
    const q = ConversationHistoryQuery.parse(request.query);
    if (q.from && q.until && Date.parse(q.from) >= Date.parse(q.until)) {
      throw new AppError("validation_failed", {}, { detail: "Choose an end time after the start." });
    }
    const before = q.cursor ? decodeCursor(q.cursor) : undefined;
    const rows = await deps.db.withWorkspace(workspaceId, async (tx) => {
      await getBot(tx, botId);
      return listConversationHistory(tx, botId, q, before);
    });
    const data = rows.slice(0, q.limit);
    const last = data.at(-1);
    const cursor =
      last && rows.length > q.limit
        ? Buffer.from(JSON.stringify({ lastActivityAt: last.lastActivityAt, id: last.id })).toString("base64url")
        : null;
    return ConversationHistoryPage.parse({ data, nextCursor: cursor });
  });
  app.get(`${root}/:conversationId`, async (request, reply) => {
    const { workspaceId } = await requirePermission(deps, request, reply, "conversation.read");
    const p = path.safeParse(request.params);
    if (!p.success) throw new AppError("not_found");
    const { cursor, limit } = transcriptPage.parse(request.query);
    return deps.db.withWorkspace(workspaceId, async (tx) => {
      await getBot(tx, p.data.botId);
      return ConversationTranscriptPage.parse(
        await conversationTranscript(tx, p.data.botId, p.data.conversationId, limit, cursor),
      );
    });
  });
}
