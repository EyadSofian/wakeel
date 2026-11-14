import { AppError, type Trace, TurnId } from "@wakeel/contracts";
import { listTurnSpans } from "@wakeel/db";
import type { FastifyInstance } from "fastify";
import { requirePermission, type StudioDeps } from "../studio";

/**
 * Traces (task 4.7, architecture §12, ADR-026): `GET /v1/workspaces/{workspaceId}/turns/{turnId}/trace`
 * returns a turn's spans ordered by seq. The emulator reads it for earlier turns; the Conversations
 * screen (Phase 10) reuses it. A turn of another workspace is not found: RLS returns no spans.
 */
export async function traceRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  app.get("/v1/workspaces/:workspaceId/turns/:turnId/trace", async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "conversation.read");
    const parsed = TurnId.safeParse((request.params as { turnId: string }).turnId);
    if (!parsed.success) throw new AppError("not_found");
    const spans = await deps.db.withWorkspace(ctx.workspaceId, (tx) => listTurnSpans(tx, parsed.data));
    const first = spans[0];
    if (!first) throw new AppError("not_found");
    const trace: Trace = { turnId: parsed.data, conversationId: first.conversationId, spans };
    return trace;
  });
}
