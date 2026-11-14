import {
  AppError,
  MODEL_PROVIDERS,
  ModelDefaultsRequest,
  type ModelKeyStatus,
  ModelProvider,
  type ModelSummary,
  modelBaseUrlSecret,
  modelKeySecret,
  PutModelKeyRequest,
} from "@wakeel/contracts";
import {
  deleteSecret,
  getWorkspace,
  type Keyring,
  listSecrets,
  readSecretValue,
  storeSecretValue,
  type Tx,
  updateWorkspace,
} from "@wakeel/db";
import { type Registry, registry as shippedRegistry } from "@wakeel/llm";
import { audit } from "@wakeel/telemetry";
import type { FastifyInstance } from "fastify";
import { auditActor, requireMember, type StudioDeps } from "../studio";

export interface ModelDeps {
  studio: StudioDeps;
  /** Seals provider keys in workspace_secrets (task 1.5). */
  keyring: Keyring;
  registry?: Registry;
}

/**
 * Settings → Models (task 6.2, design system §5.13): the registry's models with whether the
 * workspace can use them, the provider keys (write-only: only their last four characters come
 * back), and the default and utility models.
 */
export async function modelRoutes(app: FastifyInstance, deps: ModelDeps): Promise<void> {
  const registry = deps.registry ?? shippedRegistry;
  const base = "/v1/workspaces/:workspaceId";

  async function keyStatuses(tx: Tx, workspaceId: string): Promise<ModelKeyStatus[]> {
    const stored = new Map((await listSecrets(tx)).map((s) => [s.name, s]));
    return Promise.all(
      MODEL_PROVIDERS.map(async (provider) => {
        const summary = stored.get(modelKeySecret(provider));
        if (!summary) return { provider, set: false, last4: null, baseUrl: null, updatedAt: null };
        const key = await readSecretValue(tx, deps.keyring, workspaceId, modelKeySecret(provider));
        const baseUrl = stored.has(modelBaseUrlSecret(provider))
          ? ((await readSecretValue(tx, deps.keyring, workspaceId, modelBaseUrlSecret(provider)))?.reveal() ?? null)
          : null;
        return {
          provider,
          set: true,
          last4: key ? key.reveal().slice(-4) : null,
          baseUrl,
          updatedAt: summary.updatedAt.toISOString(),
        };
      }),
    );
  }

  app.get(`${base}/models`, async (request, reply) => {
    const ctx = await requireMember(deps.studio, request, reply, "bot.read");
    const keys = await deps.studio.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const names = new Set((await listSecrets(tx)).map((s) => s.name));
      return new Set(MODEL_PROVIDERS.filter((p) => names.has(modelKeySecret(p))));
    });
    const data: ModelSummary[] = registry.models().map((m) => ({
      id: m.id,
      provider: m.provider,
      kind: m.kind,
      contextWindow: m.contextWindow,
      capabilities: m.capabilities,
      autonomy: m.autonomy,
      prices: m.prices ? { inputPerMTok: m.prices.inputPerMTok, outputPerMTok: m.prices.outputPerMTok } : null,
      keySet: keys.has(m.provider),
    }));
    return { data, nextCursor: null };
  });

  app.get(`${base}/model-keys`, async (request, reply) => {
    const ctx = await requireMember(deps.studio, request, reply, "secret.read");
    const data = await deps.studio.db.withWorkspace(ctx.workspaceId, (tx) => keyStatuses(tx, ctx.workspaceId));
    return { data, nextCursor: null };
  });

  app.put(`${base}/model-keys/:provider`, async (request, reply) => {
    const ctx = await requireMember(deps.studio, request, reply, "secret.write");
    const provider = ModelProvider.parse((request.params as { provider: string }).provider);
    const body = PutModelKeyRequest.parse(request.body);
    if (provider === "openai-compatible" && !body.baseUrl)
      throw new AppError(
        "validation_failed",
        {},
        {
          errors: [
            { path: "baseUrl", code: "required", message: "An OpenAI-compatible server needs its https address" },
          ],
        },
      );
    const status = await deps.studio.db.withWorkspace(ctx.workspaceId, async (tx) => {
      await storeSecretValue(tx, deps.keyring, {
        workspaceId: ctx.workspaceId,
        name: modelKeySecret(provider),
        value: body.apiKey,
      });
      if (provider === "openai-compatible" && body.baseUrl)
        await storeSecretValue(tx, deps.keyring, {
          workspaceId: ctx.workspaceId,
          name: modelBaseUrlSecret(provider),
          value: body.baseUrl,
        });
      // The secret's name only; never its value (task 1.6).
      await audit(tx, auditActor(ctx, request), {
        action: "secret.written",
        target: { type: "secret", id: modelKeySecret(provider) },
        meta: { provider },
      });
      return (await keyStatuses(tx, ctx.workspaceId)).find((s) => s.provider === provider);
    });
    return reply.header("cache-control", "no-store").send(status);
  });

  app.delete(`${base}/model-keys/:provider`, async (request, reply) => {
    const ctx = await requireMember(deps.studio, request, reply, "secret.write");
    const provider = ModelProvider.parse((request.params as { provider: string }).provider);
    await deps.studio.db.withWorkspace(ctx.workspaceId, async (tx) => {
      await deleteSecret(tx, modelKeySecret(provider));
      if (provider === "openai-compatible") await deleteSecret(tx, modelBaseUrlSecret(provider)).catch(() => undefined);
      await audit(tx, auditActor(ctx, request), {
        action: "secret.deleted",
        target: { type: "secret", id: modelKeySecret(provider) },
        meta: { provider },
      });
    });
    return reply.code(204).send();
  });

  app.put(`${base}/model-defaults`, async (request, reply) => {
    const ctx = await requireMember(deps.studio, request, reply, "workspace.update");
    const body = ModelDefaultsRequest.parse(request.body);
    const errors = (["defaultModel", "utilityModel"] as const).flatMap((field) => {
      const id = body[field];
      if (id === null) return [];
      const model = registry.models().find((m) => m.id === id);
      if (!model) return [{ path: field, code: "unknown_model", message: `${id} is not an available model` }];
      if (model.kind !== "chat") return [{ path: field, code: "not_chat", message: `${id} is not a chat model` }];
      return [];
    });
    if (errors.length > 0) throw new AppError("validation_failed", {}, { errors });
    const settings = await deps.studio.db.withWorkspace(ctx.workspaceId, async (tx) => {
      const before = await getWorkspace(tx);
      const next = {
        ...before.settings,
        ...(body.defaultModel === null ? { defaultModel: undefined } : { defaultModel: body.defaultModel }),
        ...(body.utilityModel === null ? { utilityModel: undefined } : { utilityModel: body.utilityModel }),
      };
      for (const k of ["defaultModel", "utilityModel"] as const) if (next[k] === undefined) delete next[k];
      const after = await updateWorkspace(tx, { settings: next });
      await audit(tx, auditActor(ctx, request), {
        action: "workspace.updated",
        target: { type: "workspace", id: after.id },
        meta: { defaultModel: body.defaultModel, utilityModel: body.utilityModel },
      });
      return after.settings;
    });
    return { defaultModel: settings.defaultModel ?? null, utilityModel: settings.utilityModel ?? null };
  });
}
