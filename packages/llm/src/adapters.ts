import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { ModelEntry } from "./registry";

/**
 * Provider adapters (ADR-010): the AI SDK's provider packages behind one function. The SDK's types
 * stay in this package; callers see `LlmClient` only.
 */

export interface Credential {
  apiKey: string;
  /** For OpenAI-compatible servers (vLLM, Ollama, OpenRouter). */
  baseURL?: string;
  source: "workspace" | "platform";
}

export interface ModelFactory {
  language(model: ModelEntry, credential: Credential): LanguageModel;
  embedding(model: ModelEntry, credential: Credential): EmbeddingModel;
}

export const aiSdkModels: ModelFactory = {
  language(model, c) {
    switch (model.provider) {
      case "anthropic":
        return createAnthropic({ apiKey: c.apiKey })(model.providerModel);
      case "openai":
        return createOpenAI({ apiKey: c.apiKey })(model.providerModel);
      case "google":
        return createGoogle({ apiKey: c.apiKey })(model.providerModel);
      case "openai-compatible":
        return createOpenAICompatible({ name: "compatible", apiKey: c.apiKey, baseURL: requireBaseUrl(model, c) })(
          model.providerModel,
        );
    }
  },
  embedding(model, c) {
    switch (model.provider) {
      case "openai":
        return createOpenAI({ apiKey: c.apiKey }).embedding(model.providerModel);
      case "google":
        return createGoogle({ apiKey: c.apiKey }).embedding(model.providerModel);
      case "openai-compatible":
        return createOpenAICompatible({
          name: "compatible",
          apiKey: c.apiKey,
          baseURL: requireBaseUrl(model, c),
        }).embeddingModel(model.providerModel);
      case "anthropic":
        throw new Error(`${model.id}: Anthropic has no embedding models`);
    }
  },
};

function requireBaseUrl(model: ModelEntry, c: Credential): string {
  if (!c.baseURL) throw new Error(`${model.id}: an OpenAI-compatible model needs a base URL with its key`);
  return c.baseURL;
}
