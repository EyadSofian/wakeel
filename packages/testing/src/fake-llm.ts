import { createHash } from "node:crypto";
import { abortError, type FakeClock } from "./clock";
import { chunkText } from "./text";

/**
 * A scripted stand-in for the model layer (ADR-010: stream, generateObject, embed, rerank). Tests
 * queue responses, run the code under test, then inspect `calls`. Nothing touches the network.
 *
 * The shapes here are the minimum the engine needs; `packages/llm` (Phase 6) owns the real
 * interface, and this fake follows it when it lands.
 */

export interface FakeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface StreamRequest {
  model: string;
  /** Opaque to the fake; recorded for assertions. */
  messages?: unknown;
  system?: unknown;
  stop?: string[];
  signal?: AbortSignal;
  purpose?: string;
}

export type FinishReason = "stop" | "length" | "error";

export interface StreamResult {
  text: string;
  finishReason: FinishReason;
  usage: FakeUsage;
  /** Clock time from the call to the first chunk, or undefined if nothing was produced. */
  ttftMs: number | undefined;
}

export interface StreamHandle {
  /** Text chunks as they arrive. Iterate once. */
  textStream: AsyncIterable<string>;
  /** Settles when the stream ends: resolves with the totals, or rejects with the scripted error. */
  result: Promise<StreamResult>;
}

export interface ScriptedChunk {
  text: string;
  /** Clock time to wait before this chunk. Needs a FakeClock; without one, chunks arrive at once. */
  delayMs?: number;
}

interface StreamScript {
  kind: "stream";
  chunks: ScriptedChunk[];
  usage: Partial<FakeUsage>;
  finishReason: FinishReason;
  /** Thrown after this many chunks have been delivered. */
  error?: { afterChunks: number; error: Error };
}

interface ObjectScript {
  kind: "object";
  value: unknown;
  error?: Error;
}

/** An error a provider adapter would raise, with the HTTP status that drives retries. */
export class FakeLlmError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "FakeLlmError";
    this.status = status;
  }
}

export interface FakeLlmOptions {
  /** Drives chunk delays and ttft. Without it, every chunk arrives immediately. */
  clock?: FakeClock;
  /** Embedding size; the platform stores 1024-dimensional vectors (architecture §8). */
  embeddingDimensions?: number;
}

export class FakeLlm {
  readonly calls: { op: "stream" | "generateObject" | "embed" | "rerank"; request: unknown }[] = [];
  readonly #clock: FakeClock | undefined;
  readonly #dims: number;
  #streams: StreamScript[] = [];
  #objects: ObjectScript[] = [];

  constructor(options: FakeLlmOptions = {}) {
    this.#clock = options.clock;
    this.#dims = options.embeddingDimensions ?? 1024;
  }

  /** Queues one streamed response made of these chunks. */
  scriptStream(
    chunks: (string | ScriptedChunk)[],
    options: { usage?: Partial<FakeUsage>; finishReason?: FinishReason } = {},
  ): this {
    this.#streams.push({
      kind: "stream",
      chunks: chunks.map((c) => (typeof c === "string" ? { text: c } : c)),
      usage: options.usage ?? {},
      finishReason: options.finishReason ?? "stop",
    });
    return this;
  }

  /** Queues `text` split into chunks of `chunkSize` characters, `delayMs` apart. */
  scriptText(text: string, options: { chunkSize?: number; delayMs?: number; usage?: Partial<FakeUsage> } = {}): this {
    const delay = options.delayMs;
    const parts = chunkText(text, options.chunkSize ?? 8).map((t) =>
      delay === undefined ? { text: t } : { text: t, delayMs: delay },
    );
    return this.scriptStream(parts, options.usage === undefined ? {} : { usage: options.usage });
  }

  /** Queues a stream that delivers `chunks` and then fails with `error` (for example a 429 mid-stream). */
  scriptStreamError(error: Error, chunks: (string | ScriptedChunk)[] = []): this {
    this.scriptStream(chunks, { finishReason: "error" });
    const last = this.#streams.at(-1);
    if (last) last.error = { afterChunks: chunks.length, error };
    return this;
  }

  scriptObject(value: unknown): this {
    this.#objects.push({ kind: "object", value });
    return this;
  }

  scriptObjectError(error: Error): this {
    this.#objects.push({ kind: "object", value: undefined, error });
    return this;
  }

  /** Scripted responses not yet used. Tests call `expectDone()` to catch unused scripts. */
  remaining(): number {
    return this.#streams.length + this.#objects.length;
  }

  expectDone(): void {
    if (this.remaining() > 0) {
      throw new Error(`FakeLlm: ${this.remaining()} scripted response(s) were never used.`);
    }
  }

  stream(request: StreamRequest): StreamHandle {
    this.calls.push({ op: "stream", request });
    const script = this.#streams.shift();
    if (!script) {
      const error = new Error(
        `FakeLlm: no scripted stream left for call ${this.calls.length} (${request.purpose ?? request.model}).`,
      );
      const result = Promise.reject(error);
      result.catch(() => undefined); // the caller may only read textStream, which throws the same error
      return { textStream: failing(error), result };
    }
    return runStream(script, request, this.#clock);
  }

  async generateObject(request: { model: string; schema?: unknown; signal?: AbortSignal; purpose?: string }): Promise<{
    object: unknown;
    usage: FakeUsage;
  }> {
    this.calls.push({ op: "generateObject", request });
    if (request.signal?.aborted) throw abortError();
    const script = this.#objects.shift();
    if (!script) throw new Error(`FakeLlm: no scripted object left for call ${this.calls.length}.`);
    if (script.error) throw script.error;
    return { object: structuredClone(script.value), usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } };
  }

  /** Deterministic unit vectors: the same text always embeds the same way; different texts differ. */
  async embed(request: { model: string; values: string[] }): Promise<{ embeddings: number[][] }> {
    this.calls.push({ op: "embed", request });
    return { embeddings: request.values.map((v) => deterministicVector(v, this.#dims)) };
  }

  /** Scores documents by shared words with the query (case-insensitive), highest first. */
  async rerank(request: { model: string; query: string; documents: string[]; topK?: number }): Promise<{
    ranking: { index: number; score: number }[];
  }> {
    this.calls.push({ op: "rerank", request });
    const q = new Set(words(request.query));
    const ranking = request.documents
      .map((doc, index) => {
        const d = words(doc);
        const shared = d.filter((w) => q.has(w)).length;
        return { index, score: d.length === 0 ? 0 : shared / Math.sqrt(d.length * Math.max(q.size, 1)) };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
    return { ranking: ranking.slice(0, request.topK ?? ranking.length) };
  }
}

function runStream(script: StreamScript, request: StreamRequest, clock: FakeClock | undefined): StreamHandle {
  const stops = (request.stop ?? []).filter((s) => s.length > 0);
  const holdBack = Math.max(0, ...stops.map((s) => s.length - 1));
  const startedAt = clock?.now() ?? 0;

  let settle!: { resolve: (r: StreamResult) => void; reject: (e: unknown) => void };
  const result = new Promise<StreamResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller may only iterate textStream; an unobserved rejection must not crash the test run.
  result.catch(() => undefined);

  async function* textStream(): AsyncGenerator<string> {
    let emitted = "";
    let buffer = "";
    let ttftMs: number | undefined;
    let finishReason = script.finishReason;
    const emit = (text: string) => {
      if (text === "") return undefined;
      if (ttftMs === undefined) ttftMs = (clock?.now() ?? 0) - startedAt;
      emitted += text;
      return text;
    };

    try {
      let delivered = 0;
      let stopped = false;
      for (const chunk of script.chunks) {
        if (script.error && delivered === script.error.afterChunks) break;
        if (chunk.delayMs !== undefined && chunk.delayMs > 0) {
          if (!clock) throw new Error("FakeLlm: a chunk has delayMs but no clock was given.");
          await clock.sleep(chunk.delayMs, request.signal);
        }
        if (request.signal?.aborted) throw abortError();
        buffer += chunk.text;
        delivered++;

        // A stop sequence may span chunks, so look in the buffer, and keep back enough characters
        // that a stop sequence split across the next chunk is still caught.
        const hit = firstStop(buffer, stops);
        if (hit !== undefined) {
          const out = emit(buffer.slice(0, hit));
          if (out !== undefined) yield out;
          buffer = "";
          finishReason = "stop";
          stopped = true;
          break;
        }
        const safe = buffer.length - holdBack;
        if (safe > 0) {
          const out = emit(buffer.slice(0, safe));
          buffer = buffer.slice(safe);
          if (out !== undefined) yield out;
        }
      }
      if (!stopped && script.error && delivered === script.error.afterChunks) {
        throw script.error.error;
      }
      const out = emit(buffer);
      if (out !== undefined) yield out;
      settle.resolve({
        text: emitted,
        finishReason,
        usage: {
          inputTokens: script.usage.inputTokens ?? 0,
          cachedInputTokens: script.usage.cachedInputTokens ?? 0,
          outputTokens: script.usage.outputTokens ?? Math.ceil(emitted.length / 4),
        },
        ttftMs,
      });
    } catch (e) {
      settle.reject(e);
      throw e;
    }
  }

  return { textStream: textStream(), result };
}

function firstStop(text: string, stops: string[]): number | undefined {
  let best: number | undefined;
  for (const s of stops) {
    const i = text.indexOf(s);
    if (i !== -1 && (best === undefined || i < best)) best = i;
  }
  return best;
}

async function* failing(error: Error): AsyncGenerator<string> {
  yield* [];
  throw error;
}

function deterministicVector(text: string, dims: number): number[] {
  const out: number[] = [];
  let block = 0;
  while (out.length < dims) {
    const digest = createHash("sha256").update(`${block++}:${text}`).digest();
    for (let i = 0; i + 1 < digest.length && out.length < dims; i += 2) {
      out.push(digest.readUInt16BE(i) / 32_767.5 - 1);
    }
  }
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
