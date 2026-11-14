import { z } from "zod";
import { BotId, ConversationId, IsoDateTime, Json, SpanId, TurnId, WorkspaceId } from "./common";

export const SpanKind = z.enum([
  "turn",
  "node",
  "card",
  "autonomy.iteration",
  "llm.call",
  "code.exec",
  "tool.call",
  "kb.search",
  "table.op",
  "webhook.delivery",
  "error",
]);
export type SpanKind = z.infer<typeof SpanKind>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  /** Millionths of a US dollar. */
  costMicroUsd: z.number().int().nonnegative().default(0),
});
export type Usage = z.infer<typeof Usage>;

/** Where a span happened in the bot definition. */
export const Location = z.object({
  workflowId: z.string().optional(),
  nodeId: z.string().optional(),
  cardId: z.string().optional(),
  toolId: z.string().optional(),
});

/**
 * Large content. Stored inline when small, otherwise in the object store.
 * The API resolves `key` to `value` on request.
 */
export const Payload = z.union([
  z.object({ inline: z.literal(true), value: Json }),
  z.object({
    inline: z.literal(false),
    key: z.string(),
    bytes: z.number().int().nonnegative(),
    preview: z.string().max(400),
  }),
]);
export type Payload = z.infer<typeof Payload>;

const attrs = {
  turn: z.object({
    // One per inbound kind; run_from is the emulator's Run from here (ADR-025, ADR-026).
    trigger: z.enum([
      "message",
      "event",
      "user_update",
      "tool_result",
      "handoff_release",
      "timeout",
      "run_from",
      "end",
    ]),
    outcome: z.enum(["completed", "waiting", "handed_off", "ended", "failed"]).optional(),
    stepCount: z.number().int().nonnegative().optional(),
    usage: Usage.optional(),
    mode: z.enum(["live", "emulator", "eval"]),
    versionId: z.string().optional(),
  }),
  node: z.object({ nodeType: z.string(), leftBy: z.string().optional() }),
  card: z.object({
    cardType: z.string(),
    outcome: z.string(),
    /** Variable values changed by this card: id → { before, after } (redacted when sensitive). */
    writes: z.record(z.string(), z.object({ before: Json, after: Json })).optional(),
  }),
  "autonomy.iteration": z.object({
    index: z.number().int().positive(),
    status: z.enum(["exit", "run_result", "run_error", "protocol_error", "exit_invalid", "suspended", "recovered"]),
    exit: z.string().optional(),
    /** Raw model response for this iteration. */
    response: Payload.optional(),
    /** Extracted `:::run` body. */
    code: Payload.optional(),
    /** Value returned by the run block or the error fed back. */
    result: Payload.optional(),
  }),
  "llm.call": z.object({
    purpose: z.enum(["autonomy", "generate", "extract", "classify", "summarise", "judge", "answer", "ocr"]),
    model: z.string(),
    provider: z.string(),
    usage: Usage,
    ttftMs: z.number().int().nonnegative().optional(),
    finishReason: z.string().optional(),
    attempt: z.number().int().positive().default(1),
    prompt: Payload.optional(),
    completion: Payload.optional(),
  }),
  "code.exec": z.object({
    kind: z.enum(["card", "tool", "expressions", "autonomy_run"]),
    cpuMs: z.number().nonnegative().optional(),
    memoryBytes: z.number().int().nonnegative().optional(),
    logs: Payload.optional(),
    source: Payload.optional(),
  }),
  "tool.call": z.object({
    name: z.string(),
    toolType: z.enum(["code", "kb_search", "table", "workflow", "fetch", "builtin"]),
    sideEffects: z.boolean().default(false),
    input: Payload.optional(),
    output: Payload.optional(),
  }),
  "kb.search": z.object({
    query: z.string(),
    queryNormalised: z.string(),
    kbIds: z.array(z.string()),
    /** Candidates per stage with scores, so ranking can be explained. */
    dense: Payload.optional(),
    lexical: Payload.optional(),
    fused: Payload.optional(),
    reranked: Payload.optional(),
    returned: z.number().int().nonnegative(),
  }),
  "table.op": z.object({ tableId: z.string(), operation: z.string(), rowCount: z.number().int().nonnegative() }),
  "webhook.delivery": z.object({
    eventId: z.string(),
    eventType: z.string(),
    attempt: z.number().int().positive(),
    statusCode: z.number().int().optional(),
  }),
  error: z.object({ code: z.string(), message: z.string(), fix: z.string(), handledBy: z.string().optional() }),
} as const;

const spanBase = {
  id: SpanId,
  workspaceId: WorkspaceId,
  botId: BotId,
  conversationId: ConversationId,
  turnId: TurnId,
  parentId: SpanId.optional(),
  /** Order within the turn. */
  seq: z.number().int().nonnegative(),
  name: z.string().max(200),
  status: z.enum(["ok", "error"]),
  startedAt: IsoDateTime,
  durationMs: z.number().int().nonnegative(),
  location: Location.default({}),
};

const span = <K extends keyof typeof attrs>(kind: K) =>
  z.object({ ...spanBase, kind: z.literal(kind), attrs: attrs[kind] });

export const Span = z.discriminatedUnion("kind", [
  span("turn"),
  span("node"),
  span("card"),
  span("autonomy.iteration"),
  span("llm.call"),
  span("code.exec"),
  span("tool.call"),
  span("kb.search"),
  span("table.op"),
  span("webhook.delivery"),
  span("error"),
]);
export type Span = z.infer<typeof Span>;

/** A whole turn as returned by `GET …/turns/{turnId}/trace`: spans ordered by `seq`. */
export const Trace = z.object({
  turnId: TurnId,
  conversationId: ConversationId,
  spans: z.array(Span),
});
export type Trace = z.infer<typeof Trace>;

/** Payloads larger than this are written to the object store. */
export const INLINE_PAYLOAD_BYTES = 8 * 1024;
