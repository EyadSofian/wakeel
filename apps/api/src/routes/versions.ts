import { PublishRequest, type RestoreResponse, type VersionResponse, type VersionSummary } from "@wakeel/contracts";
import {
  getBot,
  getVersion,
  listVersions,
  publishDraft,
  restoreVersion,
  rollbackTo,
  type VersionSummary as StoredVersion,
  type Version,
} from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ActorContext, auditActor, requirePermission, type StudioDeps } from "../studio";

const userOf = (ctx: ActorContext) => (ctx.type === "user" ? ctx.session.user.id : null);

const toSummary = (v: StoredVersion, liveId: string | null): VersionSummary => ({
  id: v.id,
  number: v.number,
  label: v.label,
  notes: v.notes,
  definitionHash: v.definitionHash,
  createdBy: v.createdBy ? { id: v.createdBy, name: v.createdByName ?? "" } : null,
  createdAt: v.createdAt.toISOString(),
  live: v.id === liveId,
});

const toVersion = (v: Version, liveId: string | null): VersionResponse => ({
  ...toSummary(v, liveId),
  definition: v.definition as unknown as Record<string, unknown>,
});

const ListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The `nextCursor` of the previous page: the number to continue below. */
  cursor: z.coerce.number().int().positive().optional(),
});

/** Versions: publish, list, read, roll back, restore to draft (task 7.1, ADR-036). */
export async function versionRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  const base = "/v1/workspaces/:workspaceId/bots/:botId/versions";

  app.get(base, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const { botId } = request.params as { botId: string };
    const q = ListQuery.parse(request.query);
    return deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const bot = await getBot(tx, botId);
      const page = await listVersions(tx, botId, { limit: q.limit, ...(q.cursor ? { before: q.cursor } : {}) });
      return {
        data: page.data.map((v) => toSummary(v, bot.publishedVersionId)),
        nextCursor: page.next === null ? null : String(page.next),
      };
    });
  });

  app.get(`${base}/:versionId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const { botId, versionId } = request.params as { botId: string; versionId: string };
    return deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const bot = await getBot(tx, botId);
      return toVersion(await getVersion(tx, botId, versionId), bot.publishedVersionId);
    });
  });

  app.post(base, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.publish");
    const { botId } = request.params as { botId: string };
    const body = PublishRequest.parse(request.body);
    const version = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const before = await getBot(tx, botId);
      const { version } = await publishDraft(tx, {
        botId,
        label: body.label,
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        userId: userOf(ctx),
      });
      await audit(tx, auditActor(ctx, request), {
        action: "bot.published",
        target: { type: "bot", id: botId },
        meta: { versionId: version.id, number: version.number, label: version.label, from: before.publishedVersionId },
      });
      return version;
    });
    return reply.code(201).send(toSummary(version, version.id));
  });

  app.post(`${base}/:versionId/rollback`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.publish");
    const { botId, versionId } = request.params as { botId: string; versionId: string };
    const to = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const r = await rollbackTo(tx, botId, versionId);
      await audit(tx, auditActor(ctx, request), {
        action: "bot.rolled_back",
        target: { type: "bot", id: botId },
        meta: { from: r.from, to: r.to.id, number: r.to.number },
      });
      return r.to;
    });
    return reply.send(toSummary(to, to.id));
  });

  app.post(`${base}/:versionId/restore`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.update");
    const { botId, versionId } = request.params as { botId: string; versionId: string };
    const result = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const version = await getVersion(tx, botId, versionId);
      const r = await restoreVersion(tx, { botId, versionId, userId: userOf(ctx) });
      await audit(tx, auditActor(ctx, request), {
        action: "bot.restored",
        target: { type: "bot", id: botId },
        meta: { versionId, number: version.number, removedWorkflows: r.removedWorkflows },
      });
      return r;
    });
    const response: RestoreResponse = result;
    return reply.send(response);
  });
}
