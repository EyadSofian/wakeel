import {
  AppError,
  type BotManifest,
  ConfigEnv,
  type ConfigVariableResponse,
  SetConfigValueRequest,
} from "@wakeel/contracts";
import { deleteConfigValue, getBot, getDraftDoc, listConfigValues, putConfigValue, type Tx } from "@wakeel/db";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type ActorContext, auditActor, requirePermission, type StudioDeps } from "../studio";

const Params = z.object({
  botId: z.string(),
  env: ConfigEnv,
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
});

const userOf = (ctx: ActorContext) => (ctx.type === "user" ? ctx.session.user.id : null);

/** The draft manifest's declaration of `key`; an undeclared key cannot be set (ADR-037 §2). */
async function declared(tx: Tx, botId: string, key: string) {
  await getBot(tx, botId);
  const manifest = (await getDraftDoc(tx, botId, "manifest", "manifest")).doc as BotManifest;
  return manifest.configVars.find((c) => c.key === key);
}

/**
 * Builders set settings with `bot.update`; a secret also needs `secret.write`, which builders do not
 * have (ADR-037 §2). The secret check needs the manifest, so it runs after the first guard.
 */
async function guardWrite(
  deps: StudioDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  { undeclared = false }: { undeclared?: boolean } = {},
) {
  const ctx = await requirePermission(deps, request, reply, "bot.update");
  const p = Params.parse(request.params);
  const decl = await deps.db.withWorkspace(ctx.workspaceId, (tx) => declared(tx, p.botId, p.key));
  // A value whose key is no longer declared can still be deleted; it counts as secret.
  if (!decl && undeclared) {
    await requirePermission(deps, request, reply, "secret.write");
    return { ctx, p, secret: true };
  }
  if (!decl) {
    throw new AppError(
      "validation_failed",
      {},
      { errors: [{ path: "key", code: "not_declared", message: `Declare ${p.key} in the bot's settings first` }] },
    );
  }
  if (decl.secret) await requirePermission(deps, request, reply, "secret.write");
  return { ctx, p, secret: decl.secret };
}

/** Config variable values per environment (task 7.3, ADR-037). Secret values are never returned. */
export async function configVarRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  const base = "/v1/workspaces/:workspaceId/bots/:botId/config";

  app.get(base, async (request, reply) => {
    const ctx = await requirePermission(deps, request, reply, "bot.read");
    const { botId } = request.params as { botId: string };
    const data = await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      await getBot(tx, botId);
      const manifest = (await getDraftDoc(tx, botId, "manifest", "manifest")).doc as BotManifest;
      const stored = await listConfigValues(tx, deps.keyring, ctx.workspaceId, botId);
      const keys = [...new Set([...manifest.configVars.map((c) => c.key), ...stored.map((s) => s.key)])];
      return keys.map((key): ConfigVariableResponse => {
        const decl = manifest.configVars.find((c) => c.key === key);
        const secret = decl?.secret ?? stored.find((s) => s.key === key)?.isSecret ?? true;
        const state = (env: ConfigEnv) => {
          const v = stored.find((s) => s.key === key && s.env === env);
          return {
            set: v !== undefined,
            // A key declared secret now hides even a value stored while it was a setting.
            value: v && !secret ? v.value : null,
            updatedAt: v ? v.updatedAt.toISOString() : null,
          };
        };
        return {
          key,
          secret,
          description: decl?.description ?? null,
          declared: decl !== undefined,
          draft: state("draft"),
          production: state("production"),
        };
      });
    });
    return { data, nextCursor: null };
  });

  app.put(`${base}/:env/:key`, async (request, reply) => {
    const { ctx, p, secret } = await guardWrite(deps, request, reply);
    const { value } = SetConfigValueRequest.parse(request.body);
    await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      await putConfigValue(tx, deps.keyring, {
        workspaceId: ctx.workspaceId,
        botId: p.botId,
        env: p.env,
        key: p.key,
        value,
        isSecret: secret,
        userId: userOf(ctx),
      });
      await audit(tx, auditActor(ctx, request), {
        action: "config_var.set",
        target: { type: "bot", id: p.botId },
        meta: { key: p.key, env: p.env, secret },
      });
    });
    return reply.code(204).send();
  });

  app.delete(`${base}/:env/:key`, async (request, reply) => {
    const { ctx, p, secret } = await guardWrite(deps, request, reply, { undeclared: true });
    await deps.db.withWorkspace(ctx.workspaceId, async (tx) => {
      await deleteConfigValue(tx, p.botId, p.env, p.key);
      await audit(tx, auditActor(ctx, request), {
        action: "config_var.deleted",
        target: { type: "bot", id: p.botId },
        meta: { key: p.key, env: p.env, secret },
      });
    });
    return reply.code(204).send();
  });
}
