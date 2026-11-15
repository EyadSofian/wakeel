import { AppError } from "@wakeel/contracts";
import { APICallError, embedMany, type LanguageModelUsage, streamText } from "ai";
import { z } from "zod";
import { aiSdkModels, type Credential, type ModelFactory } from "./adapters";
import { costMicroUsd, type ModelEntry, type Registry, registry as shippedRegistry, type TokenUsage } from "./registry";

/**
 * The model layer's client (ADR-010, task 6.1): `stream` and `embed` over the AI SDK, with the key
 * resolved per call (BYOK), retries with backoff for retryable failures, the registry's fallback
 * models, and one usage event per successful call. `generateObject` and `rerank` arrive with the
 * tasks that first need them (6.7, 8.6).
 */

export type UsageMode = "live" | "emulator" | "eval";

export interface CallContext {
  workspaceId: string;
  /** Emulator and eval calls are recorded with their mode and never billed (CLAUDE.md §9). */
  mode: UsageMode;
  botId?: string;
  conversationId?: string;
  turnId?: string;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamRequest {
  model: string;
  /** Fixed platform text only; end-user, KB and tool text go in `messages` (CLAUDE.md §9). */
  system: string;
  messages: LlmMessage[];
  stop?: string[];
  /** 0–2; the provider's default when absent. */
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** What the call is for, for the usage record and the trace ("autonomy", "handoff_summary", …). */
  purpose: string;
  context: CallContext;
}

export interface StreamResult {
  text: string;
  finishReason: string;
  /** The model that answered: the requested one, or a fallback. */
  model: string;
  usage: TokenUsage;
  costMicroUsd: number;
}

export interface StreamHandle {
  textStream: AsyncIterable<string>;
  result: Promise<StreamResult>;
}

export interface EmbedRequest {
  model: string;
  values: string[];
  purpose: string;
  context: CallContext;
}

/** One image, read by a vision model (ADR-040: the OCR tier). No streaming: the page is one unit. */
export interface ReadImageRequest {
  model: string;
  /** Fixed platform text only; the image and anything taken from it are user content. */
  system: string;
  instruction: string;
  image: Uint8Array;
  mediaType: "image/png" | "image/jpeg";
  maxOutputTokens?: number;
  purpose: string;
  context: CallContext;
}

export interface UsageEvent {
  kind: "llm_tokens" | "embedding_tokens" | "rerank_units";
  rerankUnits?: number;
  workspaceId: string;
  mode: UsageMode;
  botId?: string;
  conversationId?: string;
  turnId?: string;
  model: string;
  provider: ModelEntry["provider"];
  keySource: Credential["source"];
  purpose: string;
  usage: TokenUsage;
  costMicroUsd: number;
}

/** Where keys come from (BYOK): the workspace's own, else the platform's if the plan allows it. */
export interface CredentialSource {
  workspaceKey(
    workspaceId: string,
    provider: ModelEntry["provider"],
  ): Promise<Omit<Credential, "source"> | string | undefined>;
  platformKey(provider: ModelEntry["provider"]): Promise<Omit<Credential, "source"> | string | undefined>;
  platformKeysAllowed(workspaceId: string): Promise<boolean>;
}

export interface LlmDeps {
  registry?: Registry;
  models?: ModelFactory;
  credentials: CredentialSource;
  /** Writes the usage event (usage_events); a failure is the caller's to log, not to fail the call. */
  onUsage(event: UsageEvent): Promise<void>;
  sleep?(ms: number): Promise<void>;
  /** [0, 1); backoff jitter. */
  random?(): number;
  /** Retries per model after the first attempt (default 2). */
  retries?: number;
  /** Tenant-defined endpoints must use egress. The default transport accepts only fixed providers. */
  rerankFetch?(request: RerankHttpRequest): Promise<{ status: number; body: unknown }>;
}

export interface RerankHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  context: CallContext;
  tenantUrl: boolean;
}

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  purpose: string;
  context: CallContext;
}

export interface LlmClient {
  stream(request: StreamRequest): StreamHandle;
  embed(request: EmbedRequest): Promise<{ embeddings: number[][]; model: string; usage: TokenUsage }>;
  readImage(request: ReadImageRequest): Promise<StreamResult>;
  rerank(request: RerankRequest): Promise<{ index: number; score: number }[]>;
}

const BASE_BACKOFF_MS = 500;

export function createLlm(deps: LlmDeps): LlmClient {
  const registry = deps.registry ?? shippedRegistry;
  const models = deps.models ?? aiSdkModels;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const retries = deps.retries ?? 2;

  async function credential(workspaceId: string, provider: ModelEntry["provider"]): Promise<Credential> {
    const own = await deps.credentials.workspaceKey(workspaceId, provider);
    if (own) return withSource(own, "workspace");
    if (await deps.credentials.platformKeysAllowed(workspaceId)) {
      const platform = await deps.credentials.platformKey(provider);
      if (platform) return withSource(platform, "platform");
    }
    throw new AppError("model_key_missing", { provider });
  }

  /**
   * Tries the model, then its fallbacks in order. Each model gets `retries` more attempts when the
   * failure is retryable (429, 5xx, timeouts), waiting 500 ms, 1 s, 2 s … with ±20% jitter. A failure
   * that is not retryable (a rejected key, a bad request) stops at once.
   */
  async function withFallback<T>(modelId: string, attempt: (model: ModelEntry) => Promise<T>): Promise<T> {
    const first = registry.get(modelId);
    const chain = [first, ...first.fallback.map((id) => registry.get(id))];
    let last: unknown;
    for (const model of chain) {
      for (let n = 0; n <= retries; n++) {
        try {
          return await attempt(model);
        } catch (error) {
          last = error;
          if (error instanceof AppError) throw error;
          if (isAuthFailure(error))
            throw new AppError("model_auth_failed", { provider: model.provider }, { cause: error });
          if (!isRetryable(error)) throw new AppError("model_unavailable", { model: model.id }, { cause: error });
          if (n < retries) await sleep(Math.round(BASE_BACKOFF_MS * 2 ** n * (0.8 + random() * 0.4)));
        }
      }
    }
    throw new AppError("model_unavailable", { model: first.id }, { cause: last });
  }

  async function record(
    kind: UsageEvent["kind"],
    request: { purpose: string; context: CallContext },
    model: ModelEntry,
    source: Credential["source"],
    usage: TokenUsage,
  ) {
    const cost = costMicroUsd(model, usage);
    await deps.onUsage({
      kind,
      ...request.context,
      model: model.id,
      provider: model.provider,
      keySource: source,
      purpose: request.purpose,
      usage,
      costMicroUsd: cost,
    });
    return cost;
  }

  return {
    async rerank(request) {
      const model = registry.get(request.model);
      if (model.kind !== "rerank" || !["tei", "cohere"].includes(model.provider))
        throw new AppError("model_not_configured");
      if (!request.query.trim() || !request.documents.length || request.documents.length > 30)
        throw new AppError("validation_failed");
      const cred = await credential(request.context.workspaceId, model.provider);
      const tei = model.provider === "tei";
      if (tei && !cred.baseURL) throw new AppError("model_not_configured");
      const http: RerankHttpRequest = {
        url: tei
          ? new URL("rerank", `${cred.baseURL?.replace(/\/$/, "")}/`).toString()
          : "https://api.cohere.com/v2/rerank",
        headers: { "content-type": "application/json", authorization: `Bearer ${cred.apiKey}` },
        body: tei
          ? { query: request.query, texts: request.documents, raw_scores: true }
          : {
              model: model.providerModel,
              query: request.query,
              documents: request.documents,
              top_n: request.documents.length,
            },
        context: request.context,
        tenantUrl: tei,
      };
      let response: { status: number; body: unknown };
      try {
        if (deps.rerankFetch) response = await deps.rerankFetch(http);
        else {
          if (http.tenantUrl) throw new AppError("fetch_blocked");
          const res = await fetch(http.url, {
            method: "POST",
            headers: http.headers,
            body: JSON.stringify(http.body),
            signal: AbortSignal.timeout(15_000),
          });
          response = { status: res.status, body: await res.json() };
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("model_unavailable", { model: model.id });
      }
      if (response.status === 401 || response.status === 403)
        throw new AppError("model_auth_failed", { provider: model.provider });
      if (response.status !== 200) throw new AppError("model_unavailable", { model: model.id });
      const schema = z.array(z.object({ index: z.number().int().nonnegative(), score: z.number().finite() }));
      const cohere = z.object({
        results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number().finite() })),
      });
      const parsed = tei ? schema.safeParse(response.body) : cohere.safeParse(response.body);
      if (!parsed.success) throw new AppError("model_unavailable", { model: model.id });
      const rows = Array.isArray(parsed.data)
        ? parsed.data
        : parsed.data.results.map((r) => ({ index: r.index, score: r.relevance_score }));
      if (
        rows.length !== request.documents.length ||
        new Set(rows.map((r) => r.index)).size !== rows.length ||
        rows.some((r) => r.index >= request.documents.length)
      )
        throw new AppError("model_unavailable", { model: model.id });
      await deps.onUsage({
        kind: "rerank_units",
        rerankUnits: request.documents.length,
        ...request.context,
        model: model.id,
        provider: model.provider,
        keySource: cred.source,
        purpose: request.purpose,
        usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
        costMicroUsd: 0,
      });
      return rows;
    },
    stream(request) {
      // Text is handed to the caller as it arrives. Retries and fallbacks happen only before the first
      // chunk; after that a failure ends the stream, since the caller has already shown part of it.
      let push: (chunk: string) => void = () => {};
      let end: (error?: unknown) => void = () => {};
      const queue: string[] = [];
      let done = false;
      let failure: unknown;
      let wake: (() => void) | undefined;
      push = (chunk) => {
        queue.push(chunk);
        wake?.();
      };
      end = (error) => {
        done = true;
        failure = error;
        wake?.();
      };

      const result = withFallback(request.model, async (model) => {
        const cred = await credential(request.context.workspaceId, model.provider);
        const run = streamText({
          // The SDK otherwise logs raw provider exceptions, which may carry secrets or prompt text.
          // fullStream below still delivers the failure to our problem/trace boundary.
          onError: () => {},
          model: models.language(model, cred),
          system: request.system,
          messages: request.messages,
          maxRetries: 0,
          ...(request.stop ? { stopSequences: request.stop } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
          ...(request.signal ? { abortSignal: request.signal } : {}),
        });
        const parts = run.fullStream[Symbol.asyncIterator]();
        let started = false;
        try {
          for (;;) {
            const next = await parts.next();
            if (next.done) break;
            const part = next.value;
            if (part.type === "error") throw part.error;
            if (part.type === "text-delta") {
              started = true;
              push(part.text);
            }
          }
        } catch (error) {
          // Text already reached the caller: another attempt would repeat it, so the call ends here.
          if (started) throw new AppError("model_unavailable", { model: model.id }, { cause: error });
          throw error;
        }
        const usage = toTokenUsage(await run.usage);
        const cost = await record("llm_tokens", request, model, cred.source, usage);
        return {
          text: await run.text,
          finishReason: await run.finishReason,
          model: model.id,
          usage,
          costMicroUsd: cost,
        } satisfies StreamResult;
      }).then(
        (r) => {
          end();
          return r;
        },
        (error: unknown) => {
          end(error);
          throw error;
        },
      );
      result.catch(() => undefined);

      const textStream: AsyncIterable<string> = {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length > 0) {
              yield queue.shift() as string;
              continue;
            }
            if (done) {
              if (failure) throw failure;
              return;
            }
            await new Promise<void>((r) => {
              wake = r;
            });
            wake = undefined;
          }
        },
      };
      return { textStream, result };
    },

    async readImage(request) {
      return withFallback(request.model, async (model) => {
        if (!model.capabilities.vision) throw new AppError("model_lacks_vision", { model: model.id });
        const cred = await credential(request.context.workspaceId, model.provider);
        const run = streamText({
          // Provider errors are mapped by withFallback; never let the SDK print raw request data.
          onError: () => {},
          model: models.language(model, cred),
          system: request.system,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: request.instruction },
                { type: "image", image: request.image, mediaType: request.mediaType },
              ],
            },
          ],
          maxRetries: 0,
          ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        });
        // Consume the stream so a provider error surfaces here and the retry policy applies.
        for await (const part of run.fullStream) if (part.type === "error") throw part.error;
        const usage = toTokenUsage(await run.usage);
        const cost = await record("llm_tokens", request, model, cred.source, usage);
        return {
          text: await run.text,
          finishReason: await run.finishReason,
          model: model.id,
          usage,
          costMicroUsd: cost,
        } satisfies StreamResult;
      });
    },

    async embed(request) {
      return withFallback(request.model, async (model) => {
        const cred = await credential(request.context.workspaceId, model.provider);
        const out = await embedMany({ model: models.embedding(model, cred), values: request.values, maxRetries: 0 });
        const usage: TokenUsage = {
          inputTokens: out.usage.tokens,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
        };
        await record("embedding_tokens", request, model, cred.source, usage);
        return { embeddings: out.embeddings, model: model.id, usage };
      });
    },
  };
}

function withSource(key: Omit<Credential, "source"> | string, source: Credential["source"]): Credential {
  return typeof key === "string" ? { apiKey: key, source } : { ...key, source };
}

function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  // Network failures before any response (connection reset, DNS) are worth another try.
  return error instanceof TypeError;
}

function isAuthFailure(error: unknown): boolean {
  return APICallError.isInstance(error) && (error.statusCode === 401 || error.statusCode === 403);
}

/** The SDK's usage, split the way prices are: uncached input, cache reads, cache writes, output. */
function toTokenUsage(u: LanguageModelUsage): TokenUsage {
  const cachedInputTokens = u.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWriteTokens = u.inputTokenDetails.cacheWriteTokens ?? 0;
  const inputTokens =
    u.inputTokenDetails.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - cachedInputTokens - cacheWriteTokens);
  return { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens: u.outputTokens ?? 0 };
}
