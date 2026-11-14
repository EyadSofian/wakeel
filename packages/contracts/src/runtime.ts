import { z } from "zod";
import { CardId, Identifier, IsoDateTime, Json, NodeId, ToolId, VariableId, WorkflowId } from "./common";
import { BotMessagePayload } from "./message";

/** One active workflow invocation. */
export const Frame = z.object({
  workflowId: WorkflowId,
  nodeId: NodeId,
  /** Index of the next card to run in a standard node. */
  cardIndex: z.number().int().nonnegative().default(0),
  /** Workflow-scoped variable values, keyed by variable id. */
  vars: z.record(VariableId, Json).default({}),
  /**
   * Values of the workflow's declared inputs, keyed by input name. Inputs have names, not variable
   * ids, and are read as `workflow.<name>` like variables (validation keeps the names apart).
   */
  inputs: z.record(Identifier, Json).default({}),
  /** Present on every frame except the bottom one: where to deliver outputs on return. */
  call: z
    .object({
      /** Output name → caller variable id (from the call card or workflow tool). */
      outputs: z.record(z.string(), VariableId).default({}),
      /** Set when an Autonomous Node called this workflow as a tool. */
      toolCallId: z.string().optional(),
    })
    .optional(),
  /** A trigger frame restores this wait when it finishes. */
  resumeWait: z.lazy(() => WaitSpec).optional(),
});
export type Frame = z.infer<typeof Frame>;

/** Why the conversation is paused. */
export const WaitSpec: z.ZodType<
  | { kind: "capture"; nodeId: string; cardId: string; attempts: number; since: string }
  | { kind: "listen"; nodeId: string; since: string }
  | { kind: "tool"; nodeId: string; toolId: string; toolCallId: string; reason?: string; since: string }
> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("capture"),
    nodeId: NodeId,
    cardId: CardId,
    attempts: z.number().int().nonnegative(),
    since: IsoDateTime,
  }),
  z.object({ kind: z.literal("listen"), nodeId: NodeId, since: IsoDateTime }),
  z.object({
    kind: z.literal("tool"),
    nodeId: NodeId,
    toolId: ToolId,
    toolCallId: z.string(),
    reason: z.string().optional(),
    since: IsoDateTime,
  }),
]);
export type WaitSpec = z.infer<typeof WaitSpec>;

/** Working memory of an Autonomous Node between turns. Keyed by `workflowId:nodeId` in the state. */
export const AutonomyMemory = z.object({
  /** Iterations used in the current turn. */
  iteration: z.number().int().nonnegative().default(0),
  /** Scratch object the model can read and write as `memo`; JSON only, max 16 KB. */
  memo: z.record(z.string(), Json).default({}),
  /** Feedback to show the model at the start of the next iteration. */
  feedback: z
    .array(
      z.object({
        kind: z.enum(["run_result", "run_error", "protocol_error", "exit_invalid", "write_rejected", "tool_resumed"]),
        text: z.string(),
      }),
    )
    .default([]),
  /** Set while a suspended tool is pending. */
  pendingTool: z.object({ toolId: ToolId, toolCallId: z.string(), name: z.string(), input: Json }).optional(),
});
export type AutonomyMemory = z.infer<typeof AutonomyMemory>;

export const ConversationStatus = z.enum(["idle", "waiting_input", "waiting_external", "handed_off", "ended"]);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

/** Stored in `conversations.state`. Serialised size limit: 256 KB. */
export const ConversationState = z.object({
  v: z.literal(1),
  status: ConversationStatus,
  /** Call stack; the last element is executing. Empty when idle. */
  stack: z.array(Frame).max(16).default([]),
  /** Conversation-scoped variable values, keyed by variable id. */
  conversationVars: z.record(VariableId, Json).default({}),
  wait: WaitSpec.optional(),
  autonomy: z.record(z.string(), AutonomyMemory).default({}),
  /** Rolling summary of transcript older than the token budget. */
  summary: z.object({ text: z.string(), throughSeq: z.number().int().nonnegative() }).optional(),
  /** Minutes; overrides the bot default when set by a card. */
  inactivityTimeoutMinutes: z.number().int().nonnegative().optional(),
});
export type ConversationState = z.infer<typeof ConversationState>;

export const STATE_MAX_BYTES = 256 * 1024;

export const emptyState = (): ConversationState => ({
  v: 1,
  status: "idle",
  stack: [],
  conversationVars: {},
  autonomy: {},
});

/** What a card (or an autonomous iteration) tells the engine to do next. Exactly one per step. */
export const StepOutcome = z.discriminatedUnion("type", [
  z.object({ type: z.literal("next") }),
  z.object({ type: z.literal("goto"), port: z.string() }),
  z.object({ type: z.literal("wait"), wait: WaitSpec }),
  z.object({
    type: z.literal("call"),
    workflowId: WorkflowId,
    inputs: z.record(z.string(), Json),
    outputs: z.record(z.string(), VariableId).default({}),
    toolCallId: z.string().optional(),
  }),
  z.object({ type: z.literal("return"), outputs: z.record(z.string(), Json).default({}) }),
  z.object({
    type: z.literal("handoff"),
    reason: z.string(),
    summary: z.string(),
    variables: z.record(z.string(), Json).default({}),
  }),
  z.object({ type: z.literal("end"), reason: z.string() }),
  z.object({ type: z.literal("fail"), error: z.object({ code: z.string(), message: z.string(), fix: z.string() }) }),
]);
export type StepOutcome = z.infer<typeof StepOutcome>;

/** Side effects a step produced, committed atomically with the new state. */
export const StepEffects = z.object({
  messages: z.array(BotMessagePayload).default([]),
  /** Variable writes already validated against schema and access rules. */
  writes: z
    .array(z.object({ scope: z.enum(["user", "conversation", "workflow"]), variableId: VariableId, value: Json }))
    .default([]),
});
export type StepEffects = z.infer<typeof StepEffects>;

/** Platform limits. Bots may lower `turnSeconds` and `stepsPerTurn`, never raise them. */
export const LIMITS = {
  stepsPerTurn: 200,
  nodeVisitsPerTurn: 25,
  stackDepth: 16,
  turnSeconds: 120,
  codeMs: 10_000,
  codeMemoryMb: 64,
  autonomyIterations: 6,
  inboundTextBytes: 16 * 1024,
  userAttributesBytes: 16 * 1024,
  fetchTimeoutMs: 10_000,
  fetchResponseBytes: 5 * 1024 * 1024,
  fetchRedirects: 5,
} as const;
