import {
  AppError,
  BotExport,
  BotName,
  type BotResponse,
  BotSlug,
  externalReferences,
  regenerateIds,
} from "@wakeel/contracts";
import { assembleDraft, type Bot, createBotFromDefinition, getBot } from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type ActorContext, auditActor, requirePermission, type StudioDeps } from "../studio";

const userOf = (ctx: ActorContext) => (ctx.type === "user" ? ctx.session.user.id : null);

const toBot = (b: Bot): BotResponse => ({
  id: b.id,
  name: b.name,
  slug: b.slug,
  defaultLocale: b.defaultLocale,
  publishedVersionId: b.publishedVersionId,
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
});

const ImportRequest = z.strictObject({ name: BotName, slug: BotSlug, file: z.unknown() });

/** Bot export and import (task 7.6, ADR-038). */
export async function portableRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  const base = "/v1/workspaces/:workspaceId/bots";

  app.get(`${base}/:botId/export`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const { botId } = request.params as { botId: string };
    const { bot, definition } = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => ({
      bot: await getBot(tx, botId),
      definition: await assembleDraft(tx, botId),
    }));
    const file: BotExport = {
      format: "wakeel.bot",
      formatVersion: 1,
      exportedAt: deps.now().toISOString(),
      definition,
    };
    return reply
      .header("content-disposition", `attachment; filename="${bot.slug}.wakeel.json"`)
      .header("cache-control", "no-store")
      .send(file);
  });

  app.post(`${base}/import`, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.create");
    const body = ImportRequest.parse(request.body);
    const parsed = BotExport.safeParse(body.file);
    if (!parsed.success) {
      throw new AppError(
        "validation_failed",
        {},
        {
          errors: [
            {
              path: "file",
              code: "not_a_bot_export",
              message: "This file is not a bot export from this platform, or it is from a newer version",
            },
          ],
        },
      );
    }
    const { definition } = regenerateIds(parsed.data.definition);
    const result = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const bot = await createBotFromDefinition(tx, {
        name: body.name,
        slug: body.slug,
        definition,
        createdBy: userOf(ctx),
      });
      // Knowledge bases and tables arrive with phases 8 and 9; until then every reference is unresolved.
      const unresolved = externalReferences(definition);
      await audit(tx, auditActor(ctx, request), {
        action: "bot.imported",
        target: { type: "bot", id: bot.id },
        meta: { name: bot.name, slug: bot.slug, unresolved: unresolved.length },
      });
      return { bot: toBot(bot), unresolved };
    });
    return reply.code(201).send(result);
  });
}
