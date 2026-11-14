import { z } from "zod";
import { IsoDateTime } from "./common";

/**
 * Workspace model settings (task 6.2, design system §5.13 Models): provider keys (write-only) and the
 * default and utility models. Model ids come from the registry in packages/llm (ADR-010).
 */

export const MODEL_PROVIDERS = ["anthropic", "openai", "google", "openai-compatible"] as const;
export const ModelProvider = z.enum(MODEL_PROVIDERS);
export type ModelProvider = z.infer<typeof ModelProvider>;

/** One registry model as the Studio's ModelPicker shows it. */
export const ModelSummary = z.object({
  id: z.string(),
  provider: ModelProvider,
  kind: z.enum(["chat", "embedding"]),
  contextWindow: z.number().int(),
  capabilities: z.object({ vision: z.boolean(), caching: z.boolean(), structuredOutput: z.boolean() }),
  autonomy: z.enum(["supported", "experimental", "unsupported", "untested"]),
  /** USD per million tokens, input and output; null when unpriced. */
  prices: z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }).nullable(),
  /** The workspace has a key for this model's provider. */
  keySet: z.boolean(),
});
export type ModelSummary = z.infer<typeof ModelSummary>;

/** A provider key's status. The key itself is never returned (write-only). */
export const ModelKeyStatus = z.object({
  provider: ModelProvider,
  set: z.boolean(),
  last4: z.string().length(4).nullable(),
  baseUrl: z.string().nullable(),
  updatedAt: IsoDateTime.nullable(),
});
export type ModelKeyStatus = z.infer<typeof ModelKeyStatus>;

export const PutModelKeyRequest = z.object({
  apiKey: z.string().trim().min(8, "Paste the whole key").max(500),
  /** Required for OpenAI-compatible servers (vLLM, Ollama, OpenRouter); ignored for the others. */
  baseUrl: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
});
export type PutModelKeyRequest = z.infer<typeof PutModelKeyRequest>;

export const ModelDefaultsRequest = z.object({
  defaultModel: z.string().min(1).max(100).nullable(),
  utilityModel: z.string().min(1).max(100).nullable(),
});
export type ModelDefaultsRequest = z.infer<typeof ModelDefaultsRequest>;

/** `workspace_secrets` names for a provider's key and base URL (SecretName convention). */
export const modelKeySecret = (provider: ModelProvider) => `${provider}.api_key`;
export const modelBaseUrlSecret = (provider: ModelProvider) => `${provider}.base_url`;
