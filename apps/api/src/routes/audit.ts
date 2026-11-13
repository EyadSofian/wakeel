import { AppError, type AuditEntryResponse, ListQuery } from "@wakeel/contracts";
import { type AuditCursor, type AuditEntry, listAudit } from "@wakeel/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission, type StudioDeps } from "../studio";

const Cursor = z.object({ at: z.iso.datetime(), id: z.string() });

const encodeCursor = (e: AuditEntry) =>
  Buffer.from(JSON.stringify({ at: e.at.toISOString(), id: e.id })).toString("base64url");

function decodeCursor(cursor: string): AuditCursor {
  try {
    const parsed = Cursor.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { at: new Date(parsed.at), id: parsed.id };
  } catch {
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "cursor", code: "invalid_cursor", message: "Use the nextCursor from the previous page" }] },
    );
  }
}

const toResponse = (e: AuditEntry): AuditEntryResponse => ({
  id: e.id,
  at: e.at.toISOString(),
  actor: { type: e.actorType, id: e.actorId },
  action: e.action,
  target: e.targetType !== null && e.targetId !== null ? { type: e.targetType, id: e.targetId } : null,
  meta: e.meta,
  ip: e.ip,
});

/** `GET /v1/workspaces/{id}/audit-log` (task 1.6): newest first, cursor-paginated. */
export async function auditRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  app.get("/v1/workspaces/:workspaceId/audit-log", async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "audit.read");
    const query = ListQuery.parse(request.query);
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    // One extra row says whether there is a next page without a count query.
    const rows = await deps.db.withWorkspace(ctx.workspaceId, (tx) =>
      listAudit(tx, before === undefined ? { limit: query.limit + 1 } : { limit: query.limit + 1, before }),
    );
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      data: page.map(toResponse),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor(last) : null,
    };
  });
}
