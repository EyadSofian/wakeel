import { AppError, Json, SpanId, Trace, TurnId } from "@wakeel/contracts";
import { listTurnSpans, tracePayloadKey } from "@wakeel/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
    return Trace.parse({ turnId: parsed.data, conversationId: first.conversationId, spans });
  });

  const selector = z.object({
    turnId: TurnId,
    spanId: SpanId,
    field: z
      .string()
      .regex(/^[a-z]+$/)
      .max(32),
  });
  app.get("/v1/workspaces/:workspaceId/turns/:turnId/trace/:spanId/payload/:field", async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "conversation.read");
    const parsed = selector.safeParse(request.params);
    if (!parsed.success) throw new AppError("not_found");
    const { turnId, spanId, field } = parsed.data;
    const key = await deps.db.withWorkspace(ctx.workspaceId, (tx) => tracePayloadKey(tx, turnId, spanId, field));
    if (!key?.startsWith(`traces/${ctx.workspaceId}/${spanId}/`)) throw new AppError("not_found");
    let bundle: Record<string, Json>;
    try {
      const bytes = await deps.objectStore.get(key);
      bundle = z.record(z.string(), Json).parse(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new AppError("not_found");
    }
    if (!Object.hasOwn(bundle, field)) throw new AppError("not_found");
    return reply.header("cache-control", "no-store").send({ value: bundle[field] });
  });
}
