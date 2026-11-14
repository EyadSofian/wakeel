import { AppError } from "@wakeel/contracts";
import { z } from "zod";
import shipped from "./models.json" with { type: "json" };

/**
 * The model registry (ADR-010): every model's provider, limits, capabilities, prices and Autonomous
 * Node support. Nothing else in the codebase names a model.
 */

const PerMTok = z.number().nonnegative();

export const ModelEntry = z.object({
  id: z.string().min(1).max(100),
  provider: z.enum(["anthropic", "openai", "google", "openai-compatible"]),
  /** The provider's own model id. */
  providerModel: z.string().min(1),
  kind: z.enum(["chat", "embedding"]),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  capabilities: z.object({ vision: z.boolean(), caching: z.boolean(), structuredOutput: z.boolean() }),
  /** USD per million tokens; null for self-hosted or unpriced models (cost 0, still metered). */
  prices: z
    .object({
      inputPerMTok: PerMTok,
      outputPerMTok: PerMTok,
      cacheReadPerMTok: PerMTok.optional(),
      cacheWritePerMTok: PerMTok.optional(),
      longContext: z
        .object({ thresholdTokens: z.number().int().positive(), inputPerMTok: PerMTok, outputPerMTok: PerMTok })
        .optional(),
    })
    .nullable(),
  priceCheckedAt: z.iso.date().optional(),
  /** Set from the adherence evals (task 6.10); "untested" until a report exists. */
  autonomy: z.enum(["supported", "experimental", "unsupported", "untested"]),
  /** Models tried, in order, when this one is unavailable after its retries. */
  fallback: z.array(z.string()).default([]),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export interface Registry {
  models(): readonly ModelEntry[];
  /** The model, or `model_not_configured` naming it. */
  get(id: string): ModelEntry;
}

/** Validates a registry file: unique ids, and every fallback names a chat model in it. */
export function loadRegistry(raw: unknown): Registry {
  const models = z.object({ models: z.array(ModelEntry) }).parse(raw).models;
  const byId = new Map(models.map((m) => [m.id, m]));
  if (byId.size !== models.length) throw new Error("The model registry has a duplicate id");
  for (const m of models) {
    for (const f of m.fallback) {
      const target = byId.get(f);
      if (!target) throw new Error(`${m.id} falls back to ${f}, which is not in the registry`);
      if (target.kind !== m.kind) throw new Error(`${m.id} falls back to ${f}, which is not a ${m.kind} model`);
    }
  }
  return {
    models: () => models,
    get(id) {
      const m = byId.get(id);
      if (!m) throw new AppError("model_not_configured", {}, { detail: `Model ${id} is not in the registry.` });
      return m;
    },
  };
}

/** The registry shipped with the platform (src/models.json). */
export const registry: Registry = loadRegistry(shipped);

export interface TokenUsage {
  /** Input tokens read at the full price (not from the cache). */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/**
 * The cost of one call in micro-USD (integer). Cache reads without their own price are charged at
 * the input price and cache writes without theirs at the input price too, which overstates rather
 * than understates. Past `longContext.thresholdTokens` of total input, the long-context prices apply
 * to the whole call.
 */
export function costMicroUsd(model: ModelEntry, usage: TokenUsage): number {
  const p = model.prices;
  if (!p) return 0;
  const totalInput = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  const long = p.longContext && totalInput > p.longContext.thresholdTokens ? p.longContext : undefined;
  const input = long?.inputPerMTok ?? p.inputPerMTok;
  const output = long?.outputPerMTok ?? p.outputPerMTok;
  // $/MTok × tokens = micro-USD exactly (10^6 cancels).
  return Math.round(
    usage.inputTokens * input +
      usage.cachedInputTokens * (p.cacheReadPerMTok ?? input) +
      usage.cacheWriteTokens * (p.cacheWritePerMTok ?? input) +
      usage.outputTokens * output,
  );
}
