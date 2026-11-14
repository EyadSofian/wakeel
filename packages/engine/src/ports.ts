import type {
  AutonomousNode,
  AutonomyMemory,
  BotDefinition,
  BotMessagePayload,
  Card,
  CardType,
  ConversationState,
  EventScope,
  Json,
  StepEffects,
  StepOutcome,
  WaitSpec,
} from "@wakeel/contracts";
import type { ExpressionScopes, SandboxPort } from "./expr/sandbox-port";

/**
 * The engine's ports (architecture §4.4, CLAUDE.md §6 "Engine"). The engine is pure: everything it
 * reads arrives in `TurnInput`, and everything it does leaves through these interfaces. The turn
 * worker (task 4.4) provides the real ones; tests provide fakes.
 */

/** Time as the engine sees it. Workers pass the system clock; tests pass `FakeClock`. */
export interface ClockPort {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** Where a step ran. `cardId` is absent for node-level work (an autonomous iteration, an Exit node). */
export interface StepLocation {
  workflowId: string;
  nodeId: string;
  cardId?: string;
}

/** `conversation.ended` reasons (04-contracts/event.ts). */
export type EndReason = "completed" | "inactivity" | "manual" | "error";

/**
 * Outbox events the engine produces. `message.created` is derived by the worker from the step's
 * messages (it assigns their ids and seq), and `turn.completed` is the worker's (§4.3).
 */
export type EngineEvent =
  | { type: "handoff.requested"; data: { reason: string; summary: string; variables: Record<string, Json> } }
  | { type: "conversation.ended"; data: { reason: EndReason; detail?: string } }
  | { type: "error"; data: { code: string; message: string; retryable: boolean } };

/** Events outside the ordered stream: delivered best-effort, never retried, no seq (§4.4 "Typing"). */
export type EphemeralEvent = { type: "typing"; data: { state: "on" | "off" } };

/** An error as a step outcome carries it (`StepOutcome` `fail`). */
export interface StepError {
  code: string;
  message: string;
  fix: string;
}

/**
 * One failure and where error resolution sent it (§4.4 "Errors"): the card's or node's own failure
 * port, the workflow's Error handler node, the bot's error workflow, the default (error message,
 * `error` event, stack cleared), or nowhere when the failure did not stop anything.
 */
export interface StepFailure extends StepError {
  location: StepLocation;
  handledBy: "port" | "error_handler" | "error_workflow" | "default" | "ignored";
}

/**
 * Everything one step changed, committed in one transaction (§4.4 "Persistence"). The worker writes
 * the state with its lease fence, the messages with ids derived from `turnId`, `stepSeq` and their
 * index, and the events into the outbox.
 */
export interface StepCommit {
  turnId: string;
  /** 1-based and contiguous within a turn, including across a resume. */
  stepSeq: number;
  state: ConversationState;
  /** Bot messages in the order they were produced. */
  messages: BotMessagePayload[];
  events: EngineEvent[];
  /** The end user's whole new values, present only when they changed. */
  user?: { vars?: Record<string, Json>; attributes?: Record<string, Json> };
  /** For spans (§4.4 "Every failure writes a span"). */
  failures: StepFailure[];
  /** Log card lines and code `log.*` calls, for the conversation log and the trace. */
  logs: StepLog[];
  /** The card or node that ran; absent when the commit holds only the effects of the inbound event. */
  step?: StepLocation & { outcome: StepOutcome["type"] };
  /** An autonomous iteration's model call, code and tool calls, for its trace spans (task 6.9). */
  iteration?: IterationTrace;
}

/**
 * One autonomous iteration as the trace records it (04-contracts/trace.ts `autonomy.iteration`,
 * `llm.call`, `tool.call`). `@wakeel/autonomy` produces it; the engine only carries it to the commit.
 */
export interface IterationTrace {
  index: number;
  status: "exit" | "run_result" | "run_error" | "protocol_error" | "exit_invalid" | "suspended" | "recovered";
  exit?: string;
  response: string;
  code?: string;
  result?: Json;
  llm: {
    model: string;
    provider?: string;
    usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
    costMicroUsd?: number;
    ttftMs?: number;
    finishReason: string;
    prompt: Json;
    startedAt: string;
    durationMs: number;
  };
  tools: {
    name: string;
    toolId?: string;
    toolType: "code" | "kb_search" | "table" | "workflow";
    sideEffects: boolean;
    input: Json;
    output?: Json;
    error?: string;
    startedAt: string;
    durationMs: number;
  }[];
}

/** A line for the conversation log and the trace (Log card, `log.*` in code). */
export interface StepLog {
  level: "info" | "warn" | "error";
  message: string;
  data?: Json;
}

/** What a card executor (or an autonomous iteration) returns: one outcome and its side effects. */
export interface StepResult {
  outcome: StepOutcome;
  messages?: BotMessagePayload[];
  /** Validated by the engine against each variable's declared scope and type before anything is applied. */
  writes?: StepEffects["writes"];
  logs?: StepLog[];
  /** The whole new `turn` scratch object, when code changed it. */
  turn?: Record<string, Json>;
  /** Set Timeout card: the conversation's new inactivity timeout; 0 means never. */
  inactivityTimeoutMinutes?: number;
  /** An Autonomous Node left through an exit: its name and data, read downstream as `event.exit`. */
  exit?: { name: string; data: Json };
  /** An autonomous iteration's trace (task 6.9). */
  iteration?: IterationTrace;
}

/** What a card executor receives. */
export interface CardContext<C extends Card = Card> {
  card: C;
  location: StepLocation & { cardId: string };
  definition: BotDefinition;
  scopes: ExpressionScopes;
  sandbox: SandboxPort;
  code: CodePort;
  /** Present when this card is resumed by the user's reply to the wait it set. */
  reply?: { wait: WaitSpec; event: EventScope };
  turnId: string;
  stepSeq: number;
  /** `turnId:stepSeq`; cards that call tenant code or external systems pass it on (§4.4). */
  idempotencyKey: string;
  now: number;
  /** Epoch milliseconds at which the turn's wall-clock limit runs out. */
  deadline: number;
  /** The handoff summary (task 5.4); resolves to "" when no summarizer is configured. */
  summarizeHandoff(reason: string): Promise<string>;
  /** The model layer for AI cards (task 6.7); absent when none is configured. */
  ai?: AiPort;
}

/**
 * One model call for an AI card (task 6.7). `system` is fixed platform text; the builder's rendered
 * instructions and any end-user text travel in `messages` (CLAUDE.md §9). `model` is a `ModelRef`
 * the engine already chose: the card's own, else the bot's default (generation) or utility model
 * (extraction, classification). The worker resolves the key, records usage and retries.
 */
export interface AiRequest {
  purpose: "ai_generate" | "ai_extract" | "ai_branch" | "capture_extract";
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
  maxOutputTokens?: number;
  turnId: string;
}

export interface AiPort {
  complete(request: AiRequest): Promise<{ text: string }>;
}

/** Runs one card. Card executors live in `src/cards` (task 4.3). Throwing an `AppError` is a `fail`. */
export type CardExecutor<C extends Card = Card> = (ctx: CardContext<C>) => Promise<StepResult>;

export type CardExecutors = { [T in CardType]?: CardExecutor<Extract<Card, { type: T }>> };

/** Why an autonomous node is stepped again after it waited. */
export type AutonomyResume =
  | { kind: "message"; event: EventScope }
  | { kind: "tool_result"; toolCallId: string; event: EventScope };

export interface AutonomyStepInput {
  node: AutonomousNode;
  location: StepLocation;
  memory: AutonomyMemory | undefined;
  resume?: AutonomyResume;
  scopes: ExpressionScopes;
  turnId: string;
  stepSeq: number;
  idempotencyKey: string;
  deadline: number;
}

export interface AutonomyStepResult extends StepResult {
  /** Stored in `state.autonomy` under `workflowId:nodeId`. */
  memory: AutonomyMemory;
}

/**
 * One iteration of an Autonomous Node (ADR-002; built in Phase 6). Outcomes it may return:
 * `next` (iterate again), `goto("exit:<exitId>" | "error")`, `wait` (`listen` or `tool`), `call`
 * (a workflow tool, with `toolCallId`), `handoff`, `end`, `fail`.
 */
export interface AutonomyPort {
  step(input: AutonomyStepInput): Promise<AutonomyStepResult>;
}

/** One scope's writes from a code run, by top-level variable name (§5.2 `scopePatches`). */
export interface CodeScopePatch {
  set?: Record<string, Json>;
  unset?: string[];
}

export type CodeScope = "workflow" | "conversation" | "user" | "turn";

export interface CodeRequest {
  /** The body of the Code card. */
  source: string;
  scopes: ExpressionScopes;
  timeoutMs: number;
  memoryMb: number;
  /** `ctx.idempotencyKey` in the guest (§4.4). */
  idempotencyKey: string;
  /** `env` keys whose values are secret, so the sandbox redacts them from logs. */
  secretKeys: string[];
}

export interface CodeLog {
  level: "info" | "warn" | "error";
  args: unknown[];
}

/** How a code run ended. `said` holds the guest's `say(...)` arguments in order, not yet validated. */
export type CodeOutcome =
  | {
      ok: true;
      value: Json | null;
      patches: Partial<Record<CodeScope, CodeScopePatch>>;
      said: unknown[];
      logs: CodeLog[];
    }
  | {
      ok: false;
      code: "code_error" | "code_syntax_error" | "code_timeout" | "code_memory_exceeded" | "internal_error";
      message: string;
      line?: number;
      column?: number;
      said: unknown[];
      logs: CodeLog[];
    };

/**
 * Runs builder code in the sandbox (ADR-003, §5). The real adapter is `createCodePort` in
 * `@wakeel/sandbox-client`; the engine never runs builder code itself. Rejects only when the run
 * could not start (the sandbox refused or was unreachable).
 */
export interface CodePort {
  run(request: CodeRequest): Promise<CodeOutcome>;
}

export interface EnginePorts {
  sandbox: SandboxPort;
  code: CodePort;
  clock: ClockPort;
  /**
   * Commits one step atomically, fenced by the conversation lease. If it rejects (the lease was
   * lost), `runTurn` rejects with the same error and does nothing further.
   */
  commitStep(commit: StepCommit): Promise<void>;
  /** Best-effort delivery of an ephemeral event. Errors are ignored. */
  emitEphemeral(event: EphemeralEvent): Promise<void>;
  /** Absent until the autonomy engine exists; reaching an Autonomous Node then fails the step. */
  autonomy?: AutonomyPort;
  /**
   * Writes the summary for a handoff with `summary: "auto"` (§9.4, task 5.4). The worker reads the
   * transcript itself; the engine passes only ids and the rendered reason. Absent: the summary is
   * empty.
   */
  handoffSummary?(input: HandoffSummaryRequest): Promise<string>;
  /** The model layer for AI cards (task 6.7). Absent: AI cards fail with `model_not_configured`. */
  ai?: AiPort;
}

/** What the engine asks the handoff summarizer for (task 5.4). */
export interface HandoffSummaryRequest {
  turnId: string;
  /** The Handoff card's rendered reason. */
  reason: string;
}

/** The inputs to one turn. Nothing here is mutated. */
export interface TurnInput {
  turnId: string;
  definition: BotDefinition;
  state: ConversationState;
  /** The inbound event, as expressions see it (`event`). */
  event: EventScope;
  user: { vars: Record<string, Json>; attributes: Record<string, Json> };
  /** Config variable values (`env`). */
  env: Record<string, Json>;
  /** Epoch milliseconds when the turn began; the wall-clock limit counts from here, across a resume. */
  startedAt: number;
  /**
   * Steps of this turn a previous worker already committed (`turns.step_count`). When it is above
   * 0 the inbound event has been applied, so the engine continues from `state` without applying it
   * again.
   */
  committedSteps?: number;
}

/** `turn.completed` status (04-contracts/event.ts). */
export type TurnStatus = "completed" | "waiting" | "handed_off" | "ended" | "failed";

export interface TurnResult {
  status: TurnStatus;
  state: ConversationState;
  /** The last committed `stepSeq`; the worker stores it as `turns.step_count`. */
  stepSeq: number;
  /** Bot messages produced by this run of the turn. */
  messageCount: number;
  /** The failure that reached the default handling, when `status` is `failed`. */
  error?: StepError;
}
