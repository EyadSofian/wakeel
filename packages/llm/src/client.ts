import { AppError } from "@wakeel/contracts";
import { APICallError, embedMany, type LanguageModelUsage, streamText } from "ai";
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

export interface UsageEvent {
  kind: "llm_tokens" | "embedding_tokens";
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
}

export interface LlmClient {
  stream(request: StreamRequest): StreamHandle;
  embed(request: EmbedRequest): Promise<{ embeddings: number[][]; model: string; usage: TokenUsage }>;
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
          model: models.language(model, cred),
          system: request.system,
          messages: request.messages,
          maxRetries: 0,
          ...(request.stop ? { stopSequences: request.stop } : {}),
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
