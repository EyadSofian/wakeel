import { can, generateKey, KEY_SCOPES, type Permission } from "@wakeel/auth";
import { type ApiKeyResponse, AppError, CreateApiKeyRequest } from "@wakeel/contracts";
import { type ApiKeyRecord, insertApiKey, listApiKeys, revokeApiKey } from "@wakeel/db";
import type { FastifyInstance } from "fastify";
import { requireMember, type StudioDeps } from "../studio";

export const toApiKeyResponse = (k: ApiKeyRecord): ApiKeyResponse => ({
  id: k.id,
  name: k.name,
  prefix: `wk_live_${k.prefix}`,
  scopes: k.scopes,
  createdBy: k.createdBy,
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  expiresAt: k.expiresAt?.toISOString() ?? null,
  revokedAt: k.revokedAt?.toISOString() ?? null,
  createdAt: k.createdAt.toISOString(),
});

/** Workspace API keys: list, create (shown once), revoke (task 1.4). People only, never keys. */
export async function apiKeyRoutes(app: FastifyInstance, deps: StudioDeps): Promise<void> {
  app.get("/v1/workspaces/:workspaceId/api-keys", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "api_key.read");
    const keys = await deps.db.withWorkspace(ctx.workspaceId, (tx) => listApiKeys(tx, "workspace"));
    return { data: keys.map(toApiKeyResponse), nextCursor: null };
  });

  app.post("/v1/workspaces/:workspaceId/api-keys", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "api_key.create");
    const body = CreateApiKeyRequest.parse(request.body);
    const scopes = [...new Set(body.scopes)];
    // A key may carry only scopes keys are allowed, and only ones its creator holds.
    const bad = scopes.filter(
      (s) => !(KEY_SCOPES as readonly string[]).includes(s) || !can(ctx.membership.role, s as Permission),
    );
    if (bad.length > 0) {
      throw new AppError(
        "validation_failed",
        {},
        {
          errors: bad.map((s) => ({
            path: "scopes",
            code: "invalid_scope",
            message: `"${s}" cannot be given to a key`,
          })),
        },
      );
    }
    const expiresAt = body.expiresAt === undefined ? undefined : new Date(body.expiresAt);
    if (expiresAt !== undefined && expiresAt <= deps.now()) {
      throw new AppError(
        "validation_failed",
        {},
        { errors: [{ path: "expiresAt", code: "in_the_past", message: "Choose a time in the future" }] },
      );
    }
    const { key, prefix, secretHash } = generateKey("workspace");
    const record = await deps.db.withWorkspace(ctx.workspaceId, (tx) =>
      insertApiKey(tx, {
        kind: "workspace",
        name: body.name,
        prefix,
        secretHash,
        scopes,
        createdBy: ctx.session.user.id,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }),
    );
    // The only response that ever contains the key.
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send({ ...toApiKeyResponse(record), key });
  });

  app.delete("/v1/workspaces/:workspaceId/api-keys/:keyId", async (request, reply) => {
    const ctx = await requireMember(deps, request, reply, "api_key.revoke");
    const { keyId } = request.params as { keyId: string };
    await deps.db.withWorkspace(ctx.workspaceId, (tx) => revokeApiKey(tx, keyId, deps.now()));
    return reply.code(204).send();
  });
}
