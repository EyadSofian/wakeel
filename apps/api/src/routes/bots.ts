import {
  AppError,
  type BotResponse,
  CreateBotRequest,
  DisplayName,
  type DraftDocResponse,
  seedSubWorkflow,
  UpdateBotRequest,
  type Workflow,
} from "@wakeel/contracts";
import {
  type Bot,
  createBot,
  createWorkflowDoc,
  type DraftDoc,
  deleteBot,
  deleteWorkflowDoc,
  getBot,
  getDraftDoc,
  listBots,
  listDraftDocs,
  saveDraftDoc,
  updateBot,
} from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type ActorContext, auditActor, requirePermission, type StudioDeps } from "../studio";

const toBot = (b: Bot): BotResponse => ({
  id: b.id,
  name: b.name,
  slug: b.slug,
  defaultLocale: b.defaultLocale,
  publishedVersionId: b.publishedVersionId,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
});

const toDoc = (d: DraftDoc): DraftDocResponse => ({
  kind: d.kind,
  docId: d.docId,
  rev: d.rev,
  doc: d.doc as Record<string, unknown>,
});

const DocParams = z.object({ botId: z.string(), kind: z.enum(["manifest", "workflow"]), docId: z.string().max(40) });

/** The user behind a request, or null for an API key (draft documents record who saved them). */
const userOf = (ctx: ActorContext) => (ctx.type === "user" ? ctx.session.user.id : null);

/** ADR-012: documents carry `ETag: "<rev>"`; writes must send it back in `If-Match`. */
const etag = (rev: number) => `"${rev}"`;

function ifMatch(request: FastifyRequest): number {
  const raw = request.headers["if-match"];
  const m = typeof raw === "string" ? /^(?:W\/)?"?(\d{1,9})"?$/.exec(raw.trim()) : null;
  if (!m) {
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "If-Match", code: "required", message: "Send the revision you edited as If-Match" }] },
    );
  }
  return Number(m[1]);
}

const sendDoc = (reply: FastifyReply, d: DraftDoc, status = 200) =>
  reply.code(status).header("etag", etag(d.rev)).header("cache-control", "no-store").send(toDoc(d));

/** Bots and their draft documents (task 2.1, ADR-006, ADR-012). */
export async function botRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  const base = "/v1/workspaces/:workspaceId/bots";

  app.get(base, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const list = await deps.db.withWorkspace(ctx.workspaceId, listBots);
    // A workspace has tens of bots; one page.
    return { data: list.map(toBot), nextCursor: null };
  });

  app.post(base, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.create");
    const body = CreateBotRequest.parse(request.body);
    const bot = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const created = await createBot(tx, {
        name: body.name,
        slug: body.slug,
        ...(body.defaultLocale === undefined ? {} : { defaultLocale: body.defaultLocale }),
        createdBy: userOf(ctx),
      });
      await audit(tx, auditActor(ctx, request), {
        action: "bot.created",
        target: { type: "bot", id: created.id },
        meta: { name: created.name, slug: created.slug },
      });
      return created;
    });
    return reply.code(201).send(toBot(bot));
  });

  app.get(`${base}/:botId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const { botId } = request.params as { botId: string };
    return deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const bot = await getBot(tx, botId);
      const docs = await listDraftDocs(tx, botId);
      return {
        ...toBot(bot),
        docs: docs.map((d) => ({
          kind: d.kind,
          docId: d.docId,
          rev: d.rev,
          name: (d.doc as { name: string }).name,
          updatedAt: d.updatedAt.toISOString(),
        })),
      };
    });
  });

  app.patch(`${base}/:botId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.update");
    const { botId } = request.params as { botId: string };
    const body = UpdateBotRequest.parse(request.body);
    const bot = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const before = await getBot(tx, botId);
      const after = await updateBot(tx, botId, { ...body, userId: userOf(ctx) });
      await audit(tx, auditActor(ctx, request), {
        action: "bot.updated",
        target: { type: "bot", id: botId },
        meta: {
          ...(after.name === before.name ? {} : { name: { from: before.name, to: after.name } }),
          ...(after.slug === before.slug ? {} : { slug: { from: before.slug, to: after.slug } }),
        },
      });
      return after;
    });
    return toBot(bot);
  });

  app.delete(`${base}/:botId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.delete");
    const { botId } = request.params as { botId: string };
    await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const bot = await getBot(tx, botId);
      await deleteBot(tx, botId);
      await audit(tx, auditActor(ctx, request), {
        action: "bot.deleted",
        target: { type: "bot", id: botId },
        meta: { name: bot.name, slug: bot.slug },
      });
    });
    return reply.code(204).send();
  });

  app.get(`${base}/:botId/docs/:kind/:docId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const p = DocParams.parse(request.params);
    const doc = await deps.db.withWorkspace(ctx.workspaceId, (tx) => getDraftDoc(tx, p.botId, p.kind, p.docId));
    return sendDoc(reply, doc);
  });

  // Autosave target (the Studio saves 800 ms after the last change). Not audited: one entry per
  // keystroke pause would drown the log; publishing (7.1) is the audited event.
  app.put(`${base}/:botId/docs/:kind/:docId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.update");
    const p = DocParams.parse(request.params);
    const expectedRev = ifMatch(request);
    const body = z.strictObject({ doc: z.unknown() }).parse(request.body);
    const saved = await deps.db.withWorkspace(ctx.workspaceId, (tx) =>
      saveDraftDoc(tx, { ...p, expectedRev, doc: body.doc, userId: userOf(ctx) }),
    );
    return sendDoc(reply, saved);
  });

  app.post(`${base}/:botId/workflows`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.update");
    const { botId } = request.params as { botId: string };
    const { name } = z.strictObject({ name: DisplayName }).parse(request.body);
    const created = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const doc = await createWorkflowDoc(tx, { botId, doc: seedSubWorkflow(name), userId: userOf(ctx) });
      await audit(tx, auditActor(ctx, request), {
        action: "workflow.created",
        target: { type: "workflow", id: doc.docId },
        meta: { botId, name },
      });
      return doc;
    });
    return sendDoc(reply, created, 201);
  });

  app.delete(`${base}/:botId/workflows/:docId`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.update");
    const { botId, docId } = request.params as { botId: string; docId: string };
    await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const doc = await getDraftDoc(tx, botId, "workflow", docId);
      await deleteWorkflowDoc(tx, botId, docId);
      await audit(tx, auditActor(ctx, request), {
        action: "workflow.deleted",
        target: { type: "workflow", id: docId },
        meta: { botId, name: (doc.doc as Workflow).name },
      });
    });
    return reply.code(204).send();
  });
}
