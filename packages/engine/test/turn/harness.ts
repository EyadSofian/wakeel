import {
  type AutonomyMemory,
  type BotDefinition,
  BotDefinition as BotDefinitionSchema,
  Card,
  type ConversationState,
  ConversationState as ConversationStateSchema,
  type EventScope,
  emptyState,
  type Json,
  newElementId,
  newId,
  type StepOutcome,
} from "@wakeel/contracts";
import { FakeClock } from "@wakeel/testing";
import type { ExpressionBatch, ExpressionOutcome, SandboxPort } from "../../src/expr/index";
import type {
  AutonomyPort,
  AutonomyStepInput,
  CardContext,
  CardExecutors,
  CodeOutcome,
  CodeRequest,
  EnginePorts,
  EphemeralEvent,
  HandoffSummaryRequest,
  StepCommit,
  StepResult,
  TurnInput,
} from "../../src/ports";
import { type RunTurnOptions, runTurn } from "../../src/turn";

/**
 * A small kit for engine tests: definitions built from plain objects (parsed, so defaults apply
 * as in production), scripted card executors, and fake ports that record everything.
 */

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

export const cardId = () => newElementId("card");
export const nodeId = () => newElementId("node");
export const wfId = () => newElementId("wf");
export const varId = () => newElementId("var");

/** A card the scripted executor runs; `log` is the simplest card to build. */
export const step = (id: string = cardId(), extra: Record<string, unknown> = {}) => ({
  id,
  type: "log",
  message: "step",
  ...extra,
});

export const capture = (id: string, into: string) => ({
  id,
  type: "capture",
  prompt: { type: "text", text: "ما اسمك؟" },
  kind: "text",
  into,
});

export const code = (id: string) => ({ id, type: "code", source: "return 1" });

export const callCard = (id: string, workflowId: string, outputs: Record<string, string> = {}) => ({
  id,
  type: "call_workflow",
  workflowId,
  outputs,
});

export const standard = (id: string, cards: unknown[], name = `Node ${id.slice(-4)}`) => ({
  id,
  type: "standard",
  name,
  cards,
});

export const edge = (from: string, port: string, to: string) => ({
  id: newElementId("edge"),
  from: { nodeId: from, port },
  to: { nodeId: to },
});

export interface WorkflowInit {
  id?: string;
  kind?: "main" | "sub" | "error";
  name?: string;
  nodes: unknown[];
  edges?: unknown[];
  inputs?: unknown[];
  outputs?: unknown[];
  variables?: unknown[];
}

export const workflow = (init: WorkflowInit) => ({
  id: init.id ?? wfId(),
  name: init.name ?? (init.kind === "sub" ? "Sub" : "Main"),
  kind: init.kind ?? "main",
  nodes: init.nodes,
  edges: init.edges ?? [],
  inputs: init.inputs ?? [],
  outputs: init.outputs ?? [],
  variables: init.variables ?? [],
});

export interface DefinitionInit {
  workflows: ReturnType<typeof workflow>[];
  variables?: unknown[];
  errorWorkflowId?: string;
  settings?: Record<string, unknown>;
}

/** The first workflow is Main. */
export function definition(init: DefinitionInit): BotDefinition {
  return BotDefinitionSchema.parse({
    schemaVersion: 1,
    manifest: {
      name: "بوت الاختبار",
      settings: {
        models: { default: "anthropic:test-model", utility: "anthropic:test-utility" },
        ...init.settings,
      },
      variables: init.variables ?? [],
      mainWorkflowId: (init.workflows[0] as { id: string }).id,
      ...(init.errorWorkflowId ? { errorWorkflowId: init.errorWorkflowId } : {}),
    },
    workflows: init.workflows,
  });
}

/**
 * Main: Start → one standard node with `cards` (and its `next` port unconnected, so the turn goes
 * idle after the last card). Returns the ids tests need.
 */
export function linearBot(cards: unknown[], extra: Partial<DefinitionInit> = {}) {
  const start = nodeId();
  const node = nodeId();
  const main = workflow({
    nodes: [{ id: start, type: "start", name: "Start" }, standard(node, cards, "Greeting")],
    edges: [edge(start, "next", node)],
  });
  const { workflows = [], ...rest } = extra;
  return { def: definition({ ...rest, workflows: [main, ...workflows] }), main, start, node };
}

/* ------------------------------------------------------------------ */
/* State and events                                                    */
/* ------------------------------------------------------------------ */

export const CONVERSATION_ID = newId("conv");
export const USER_ID = newId("eu");
export const TURN_ID = newId("turn");

/**
 * A conversation whose session has started (ADR-027), so a message does not run the
 * `conversation_started` trigger. Pass `started: undefined`, or use `freshState`, for a new one.
 */
export function state(patch: Partial<ConversationState> = {}): ConversationState {
  const parsed = ConversationStateSchema.parse({ ...emptyState(), started: true, ...patch });
  // A key patched to `undefined` means "absent", as in a stored state.
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) delete (parsed as Record<string, unknown>)[key];
  }
  return parsed;
}

/** A brand-new conversation: exactly what the worker stores before the first turn. */
export const freshState = (): ConversationState => ConversationStateSchema.parse(emptyState());

export function event(kind: EventScope["kind"], patch: Partial<EventScope> = {}): EventScope {
  return {
    kind,
    text: "",
    payload: {},
    metadata: {},
    conversationId: CONVERSATION_ID,
    externalConversationId: "chat-77",
    userId: USER_ID,
    externalUserId: "user-12",
    receivedAt: "2026-11-13T09:00:00.000Z",
    ...patch,
  };
}

export const message = (text: string) =>
  event("message", { text, message: { type: "text", text, format: "plain" } as EventScope["message"] });

/* ------------------------------------------------------------------ */
/* Executors and ports                                                 */
/* ------------------------------------------------------------------ */

export type Behaviour = (ctx: CardContext) => StepResult | Promise<StepResult>;

export const next = (): StepResult => ({ outcome: { type: "next" } });
export const outcome = (o: StepOutcome, extra: Omit<StepResult, "outcome"> = {}): StepResult => ({
  outcome: o,
  ...extra,
});
export const say = (text: string): StepResult => ({
  outcome: { type: "next" },
  messages: [{ type: "text", text, format: "markdown" }],
});

/**
 * One executor for every card type that looks up the card's id in `behaviours`; cards with no
 * entry return `next`. Every call is recorded.
 */
export function scripted(behaviours: Record<string, Behaviour> = {}) {
  const calls: CardContext[] = [];
  const run = async (ctx: CardContext) => {
    calls.push(ctx);
    const behaviour = behaviours[ctx.card.id];
    return behaviour ? behaviour(ctx) : next();
  };
  const types = Card.options.map((o) => o.shape.type.value);
  const executors = Object.fromEntries(types.map((t) => [t, run])) as CardExecutors;
  return { executors, calls, ran: () => calls.map((c) => c.card.id) };
}

export type SandboxAnswers =
  | Record<string, ExpressionOutcome>
  | ((expression: string, batch: ExpressionBatch) => ExpressionOutcome | undefined);

/**
 * A sandbox stand-in that answers from a table or a function and records every batch. It never
 * evaluates builder text (CLAUDE.md §9); expressions it has no answer for fail.
 */
export function sandbox(answers: SandboxAnswers = {}) {
  const batches: ExpressionBatch[] = [];
  const answer = (e: string, batch: ExpressionBatch) =>
    typeof answers === "function" ? answers(e, batch) : answers[e];
  const port: SandboxPort = {
    evalExpressions: async (batch) => {
      batches.push(batch);
      return batch.expressions.map((e) => answer(e, batch) ?? { ok: false, message: `no answer for ${e}` });
    },
  };
  return { port, batches };
}

export interface HarnessOptions {
  /** `commitStep` rejects for this stepSeq, like a worker that lost its lease. */
  loseLeaseAt?: number;
  autonomy?: (input: AutonomyStepInput) => StepResult & { memory?: AutonomyMemory };
  sandboxAnswers?: SandboxAnswers;
  ephemeralFails?: boolean;
  code?: (request: CodeRequest) => CodeOutcome | Promise<CodeOutcome>;
  /** The handoff summary port (task 5.4); absent means no summarizer is configured. */
  handoffSummary?: (input: HandoffSummaryRequest) => Promise<string>;
}

export function harness(options: HarnessOptions = {}) {
  const clock = new FakeClock();
  const commits: StepCommit[] = [];
  const ephemeral: EphemeralEvent[] = [];
  const autonomyCalls: AutonomyStepInput[] = [];
  const box = sandbox(options.sandboxAnswers);
  const autonomy: AutonomyPort | undefined = options.autonomy
    ? {
        step: async (input) => {
          autonomyCalls.push(structuredClone(input));
          const result = (options.autonomy as NonNullable<HarnessOptions["autonomy"]>)(input);
          return { ...result, memory: result.memory ?? { iteration: 1, memo: {}, feedback: [] } };
        },
      }
    : undefined;
  const codeRuns: CodeRequest[] = [];
  const ports: EnginePorts = {
    sandbox: box.port,
    code: {
      run: async (request) => {
        codeRuns.push(request);
        if (!options.code) throw new Error("this test runs no code");
        return options.code(request);
      },
    },
    clock,
    commitStep: async (commit) => {
      if (commit.stepSeq === options.loseLeaseAt) throw new Error("lease lost");
      commits.push(structuredClone(commit));
    },
    emitEphemeral: async (e) => {
      if (options.ephemeralFails) throw new Error("redis down");
      ephemeral.push(e);
    },
    ...(autonomy ? { autonomy } : {}),
    ...(options.handoffSummary ? { handoffSummary: options.handoffSummary } : {}),
  };
  return { clock, commits, ephemeral, ports, autonomyCalls, batches: box.batches, codeRuns };
}

export interface RunInit {
  def: BotDefinition;
  state?: ConversationState;
  event?: EventScope;
  user?: TurnInput["user"];
  env?: Record<string, Json>;
  committedSteps?: number;
  /** Defaults to the fake clock's current time. */
  startedAt?: number;
  executors?: CardExecutors;
  h?: ReturnType<typeof harness>;
}

/** Runs a turn with fakes; returns the result and everything the ports saw. */
export async function run(init: RunInit) {
  const h = init.h ?? harness();
  const input: TurnInput = {
    turnId: TURN_ID,
    definition: init.def,
    state: init.state ?? state(),
    event: init.event ?? message("مرحبا"),
    user: init.user ?? { vars: {}, attributes: {} },
    env: init.env ?? {},
    startedAt: init.startedAt ?? h.clock.now(),
    ...(init.committedSteps !== undefined ? { committedSteps: init.committedSteps } : {}),
  };
  const options: RunTurnOptions = init.executors ? { executors: init.executors } : {};
  const result = await runTurn(input, h.ports, options);
  return { result, input, ...h };
}

/** The text of every bot message across commits, in order. */
export const texts = (commits: readonly StepCommit[]) =>
  commits.flatMap((c) => c.messages.map((m) => (m.type === "text" ? m.text : `[${m.type}]`)));

export const events = (commits: readonly StepCommit[]) => commits.flatMap((c) => c.events);
export const failures = (commits: readonly StepCommit[]) => commits.flatMap((c) => c.failures);
