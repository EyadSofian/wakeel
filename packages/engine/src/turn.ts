import {
  AppError,
  type AutonomousNode,
  type BotMessagePayload,
  BotSettings,
  type Card,
  type ConversationState,
  type ErrorCode,
  emptyState,
  type Frame,
  type Json,
  LIMITS,
  type Node,
  StepOutcome,
  type WaitSpec,
} from "@wakeel/contracts";
import { CARD_EXECUTORS } from "./cards/index";
import { type DefinitionIndex, indexDefinition } from "./definition";
import { type ExpressionResult, evalExpressions } from "./expr/evaluate";
import type { ExpressionScopes } from "./expr/sandbox-port";
import { renderTemplate } from "./expr/template";
import type {
  AutonomyResume,
  CardExecutor,
  CardExecutors,
  EndReason,
  EngineEvent,
  EnginePorts,
  StepCommit,
  StepError,
  StepFailure,
  StepLocation,
  StepLog,
  StepResult,
  TurnInput,
  TurnResult,
  TurnStatus,
} from "./ports";
import { toStepError } from "./step-error";
import { findEventTrigger, findMainTrigger } from "./triggers";
import { applyWrites, buildScopes, checkType, stateSizeError, type VariableWrite, writeFor } from "./variables";

export interface RunTurnOptions {
  /** Card executors by card type; defaults to the engine's own (`src/cards`). */
  executors?: CardExecutors;
}

/**
 * Runs one turn (architecture §4.4): applies the inbound event to the conversation state, then
 * executes steps until the conversation waits, goes idle, ends or hands off. Each step is
 * committed through `ports.commitStep` before the next one starts, so a worker that dies mid-turn
 * can resume from the last commit by passing `committedSteps`.
 *
 * Pure: reads only its input, does I/O only through `ports`, and never mutates `input`.
 */
export async function runTurn(input: TurnInput, ports: EnginePorts, options: RunTurnOptions = {}): Promise<TurnResult> {
  return new TurnRun(input, ports, options.executors ?? CARD_EXECUTORS).run();
}

/** Failures that would hit the same limit again in any handler, so they go straight to the default. */
const BUDGET_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "step_limit_exceeded",
  "turn_timeout",
  "state_too_large",
]);

/** Codes for which sending the same input again may succeed (`error` event `retryable`). */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "turn_timeout",
  "model_unavailable",
  "fetch_failed",
  "internal_error",
]);

const END_REASONS: ReadonlySet<string> = new Set<EndReason>(["completed", "inactivity", "manual", "error"]);

const DEFAULT_ERROR_MESSAGE = BotSettings.shape.errorMessage.parse(undefined);

interface Snapshot {
  state: ConversationState;
  messages: number;
  events: number;
}

class TurnRun {
  readonly #input: TurnInput;
  readonly #ports: EnginePorts;
  readonly #executors: CardExecutors;
  readonly #index: DefinitionIndex;
  readonly #stepsLimit: number;
  readonly #deadline: number;

  #state: ConversationState;
  readonly #user: { vars: Record<string, Json>; attributes: Record<string, Json> };
  readonly #turnScope: Record<string, Json> = {};
  readonly #visits = new Map<string, number>();

  /** The current step's sequence number in this turn, counting those of a worker that died. */
  #stepSeq: number;
  /** The last `stepSeq` committed; a step is pending while `#stepSeq` is ahead of it. */
  #committedSeq: number;

  // Not yet committed.
  #messages: BotMessagePayload[] = [];
  #events: EngineEvent[] = [];
  #failures: StepFailure[] = [];
  #logs: StepLog[] = [];
  #userVarsChanged = false;
  #attributesChanged = false;
  #dirty = false;
  #lastStep: StepCommit["step"];

  /** The user's reply, for the capture card that waited for it; consumed by the next step. */
  #reply: { wait: WaitSpec; event: TurnInput["event"] } | undefined;
  #autonomyResume: AutonomyResume | undefined;
  /** The autonomous node `#autonomyResume` is for: the node that set the wait. */
  #resumeFor: string | undefined;
  /** Error handler and error workflow are each used at most once a turn, so a failing handler cannot loop. */
  #handlerUsed = false;
  #unhandled: StepError | undefined;
  #pendingErrorMessage = false;
  #messageCount = 0;

  constructor(input: TurnInput, ports: EnginePorts, executors: CardExecutors) {
    this.#input = input;
    this.#ports = ports;
    this.#executors = executors;
    this.#index = indexDefinition(input.definition);
    this.#state = structuredClone(input.state);
    this.#user = structuredClone(input.user);
    this.#stepSeq = input.committedSteps ?? 0;
    this.#committedSeq = this.#stepSeq;
    const limits = input.definition.manifest.settings.limits;
    this.#stepsLimit = Math.min(limits.stepsPerTurn, LIMITS.stepsPerTurn);
    this.#deadline = input.startedAt + Math.min(limits.turnSeconds, LIMITS.turnSeconds) * 1000;
  }

  async run(): Promise<TurnResult> {
    if (this.#stepSeq === 0) await this.#applyEvent();
    let typing = false;
    if (this.#runnable()) {
      typing = true;
      await this.#ephemeral("on");
      await this.#loop();
    }
    if (this.#dirty) {
      // Changes after the last committed step (a transition, a failure, the inbound event alone)
      // get a sequence number of their own.
      if (this.#stepSeq === this.#committedSeq) this.#stepSeq++;
      await this.#flush();
    }
    if (typing) await this.#ephemeral("off");
    return {
      status: this.#status(),
      state: this.#state,
      stepSeq: this.#stepSeq,
      messageCount: this.#messageCount,
      ...(this.#unhandled ? { error: this.#unhandled } : {}),
    };
  }

  #status(): TurnStatus {
    if (this.#unhandled) return "failed";
    switch (this.#state.status) {
      case "waiting_input":
      case "waiting_external":
        return "waiting";
      case "handed_off":
        return "handed_off";
      case "ended":
        return "ended";
      case "idle":
        return "completed";
    }
  }

  /** Steps can run: there is a frame, nothing is awaited, and the bot is not silenced. */
  #runnable(): boolean {
    const s = this.#state;
    return s.stack.length > 0 && s.wait === undefined && s.status !== "handed_off" && s.status !== "ended";
  }

  #top(): Frame {
    return this.#state.stack.at(-1) as Frame;
  }

  #touch(): void {
    this.#dirty = true;
  }

  async #ephemeral(state: "on" | "off"): Promise<void> {
    try {
      await this.#ports.emitEphemeral({ type: "typing", data: { state } });
    } catch {
      // Best-effort by definition (§4.4 "Typing").
    }
  }

  /* ------------------------------------------------------------------ */
  /* The inbound event (§4.4 event table)                                */
  /* ------------------------------------------------------------------ */

  async #applyEvent(): Promise<void> {
    const event = this.#input.event;
    const state = this.#state;
    switch (event.kind) {
      case "user_update": {
        const attributes = event.payload["attributes"];
        if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
          Object.assign(this.#user.attributes, attributes);
          this.#attributesChanged = true;
          this.#touch();
        }
        return;
      }
      case "message":
        switch (state.status) {
          case "handed_off":
            return;
          case "ended":
            this.#state = emptyState();
            this.#touch();
            this.#startMain();
            return;
          case "idle":
            this.#startMain();
            return;
          case "waiting_input": {
            const wait = state.wait as WaitSpec;
            this.#clearWait();
            if (wait.kind === "capture") this.#reply = { wait, event };
            else {
              this.#autonomyResume = { kind: "message", event };
              this.#resumeFor = wait.nodeId;
            }
            return;
          }
          case "waiting_external":
            await this.#sendBusyMessage();
            return;
        }
        return;
      case "event": {
        if (state.status === "handed_off" || state.status === "ended") return;
        const name = event.name ?? "";
        const found = findEventTrigger(
          this.#index,
          state.stack.map((f) => f.workflowId),
          name,
        );
        if (found) this.#pushTrigger(found.workflowId, found.node);
        return;
      }
      case "tool_result": {
        const wait = state.wait;
        if (state.status !== "waiting_external" || wait?.kind !== "tool") return;
        if (event.payload["toolCallId"] !== wait.toolCallId) return;
        this.#clearWait();
        this.#autonomyResume = { kind: "tool_result", toolCallId: wait.toolCallId, event };
        this.#resumeFor = wait.nodeId;
        return;
      }
      case "handoff_release": {
        if (state.status !== "handed_off") return;
        state.status = "idle";
        this.#touch();
        const found = findMainTrigger(this.#index, "handoff_released");
        if (found) this.#pushTrigger(found.workflowId, found.node);
        return;
      }
      case "timeout": {
        if (state.status !== "waiting_input" && state.status !== "waiting_external") return;
        const found = findMainTrigger(this.#index, "inactivity");
        if (found) this.#pushTrigger(found.workflowId, found.node);
        else this.#end("inactivity");
        return;
      }
      case "run_from":
        this.#runFrom(event.payload);
        return;
    }
  }

  /**
   * The emulator's "Run from here" (ADR-025): whatever the conversation was doing is dropped, and the
   * turn starts at the named node. Only the Studio emulator inserts this event.
   */
  #runFrom(payload: Record<string, unknown>): void {
    const { workflowId, nodeId } = payload;
    this.#state.stack = [];
    delete this.#state.wait;
    this.#state.status = "idle";
    this.#touch();
    if (typeof workflowId !== "string" || typeof nodeId !== "string") {
      this.#fail(new AppError("validation_failed", {}, { detail: "Run from here needs a workflowId and a nodeId." }), {
        workflowId: typeof workflowId === "string" ? workflowId : this.#index.mainWorkflowId,
        nodeId: "",
      });
      return;
    }
    if (!this.#index.node(workflowId, nodeId)) {
      this.#fail(new AppError("not_found", {}, { detail: `Node ${nodeId} is not in workflow ${workflowId}.` }), {
        workflowId,
        nodeId,
      });
      return;
    }
    this.#push({ workflowId, nodeId, cardIndex: 0, vars: {}, inputs: {} });
  }

  #clearWait(): void {
    delete this.#state.wait;
    this.#state.status = "idle";
    this.#touch();
  }

  #setWait(wait: WaitSpec): void {
    this.#state.wait = wait;
    this.#state.status = wait.kind === "tool" ? "waiting_external" : "waiting_input";
    this.#touch();
  }

  #startMain(): void {
    const mainId = this.#index.mainWorkflowId;
    const start = this.#index.first(mainId, "start");
    if (!start) {
      this.#fail(new AppError("not_found", {}, { detail: "The main workflow has no Start node." }), {
        workflowId: mainId,
        nodeId: "",
      });
      return;
    }
    this.#push({ workflowId: mainId, nodeId: start.id, cardIndex: 0, vars: {}, inputs: {} });
  }

  /** Runs a Trigger node on top of the stack; when its path finishes, the wait it interrupted comes back. */
  #pushTrigger(workflowId: string, node: Node): void {
    const frame: Frame = { workflowId, nodeId: node.id, cardIndex: 0, vars: {}, inputs: {} };
    if (this.#state.wait) frame.resumeWait = this.#state.wait;
    delete this.#state.wait;
    this.#state.status = "idle";
    this.#push(frame);
  }

  /**
   * Pushes a frame at its first node, checking the stack depth and counting the visit. A failure is
   * reported at `from`, the place that asked for the frame.
   */
  #push(frame: Frame, from: StepLocation = { workflowId: frame.workflowId, nodeId: frame.nodeId }): void {
    this.#touch();
    if (this.#state.stack.length >= LIMITS.stackDepth) {
      this.#fail(new AppError("stack_overflow", { limit: LIMITS.stackDepth }), from);
      return;
    }
    this.#state.stack.push(frame);
    this.#countVisit(frame.workflowId, frame.nodeId);
  }

  async #sendBusyMessage(): Promise<void> {
    const wait = this.#state.wait;
    const frame = this.#top();
    if (wait?.kind !== "tool" || !frame) return;
    const node = this.#index.node(frame.workflowId, wait.nodeId);
    if (node?.type !== "autonomous" || !node.busyMessage) return;
    const location = { workflowId: frame.workflowId, nodeId: node.id };
    try {
      const text = await renderTemplate(node.busyMessage, this.#scopes(frame), this.#ports.sandbox);
      if (text.trim() !== "") this.#emitMessages([{ type: "text", text, format: "markdown" }]);
    } catch (error) {
      // The suspended tool is still pending; a broken busy text must not end it.
      this.#failures.push({ ...toStepError(error, this.#input.turnId), location, handledBy: "ignored" });
      this.#touch();
    }
  }

  /* ------------------------------------------------------------------ */
  /* The step loop                                                       */
  /* ------------------------------------------------------------------ */

  async #loop(): Promise<void> {
    while (this.#runnable()) {
      const frame = this.#top();
      const location: StepLocation = { workflowId: frame.workflowId, nodeId: frame.nodeId };
      const node = this.#index.node(frame.workflowId, frame.nodeId);
      if (!node) {
        this.#fail(
          new AppError("not_found", {}, { detail: `Node ${frame.nodeId} is not in the definition.` }),
          location,
        );
        continue;
      }
      switch (node.type) {
        case "start":
        case "entry":
        case "trigger":
        case "error_handler":
          this.#follow(node, "next");
          break;
        case "standard": {
          const card = node.cards[frame.cardIndex];
          if (!card) this.#follow(node, "next");
          else if (card.disabled) frame.cardIndex++;
          else await this.#runCard(frame, node, card);
          break;
        }
        case "autonomous":
          await this.#runAutonomy(frame, node);
          break;
        case "exit":
          await this.#runExit(frame, node);
          break;
        case "end":
          await this.#runEnd(frame, node);
          break;
        case "note":
          this.#fail(new AppError("no_route", { node: node.name }), location);
          break;
      }
    }
  }

  /**
   * Starts a step: commits the previous one, then checks the turn's budget. Returns false when a
   * limit stopped the turn instead.
   */
  async #beginStep(location: StepLocation): Promise<boolean> {
    // The inbound event's effects stay pending until the first step, so they commit together: a
    // capture card must never lose the reply it is fed.
    if (this.#stepSeq > this.#committedSeq) await this.#flush();
    if (this.#stepSeq >= this.#stepsLimit) {
      this.#fail(new AppError("step_limit_exceeded", { limit: this.#stepsLimit }), location);
      return false;
    }
    if (this.#ports.clock.now() >= this.#deadline) {
      const limit = (this.#deadline - this.#input.startedAt) / 1000;
      this.#fail(new AppError("turn_timeout", { limit }), location);
      return false;
    }
    this.#stepSeq++;
    return true;
  }

  async #runCard(frame: Frame, node: Extract<Node, { type: "standard" }>, card: Card): Promise<void> {
    const location = { workflowId: frame.workflowId, nodeId: node.id, cardId: card.id };
    if (!(await this.#beginStep(location))) return;
    const failurePort = cardFailurePort(card);
    const executor = this.#executors[card.type] as CardExecutor | undefined;
    // The reply belongs to the card that asked; after a definition change the cursor may be elsewhere.
    const reply = this.#reply?.wait.kind === "capture" && this.#reply.wait.cardId === card.id ? this.#reply : undefined;
    this.#reply = undefined;
    const snapshot = this.#snapshot();
    let result: StepResult;
    try {
      if (!executor)
        throw new AppError(
          "internal_error",
          { requestId: this.#input.turnId },
          { detail: `No executor for ${card.type} cards.` },
        );
      result = await executor({
        card,
        location,
        definition: this.#input.definition,
        scopes: this.#scopes(frame),
        sandbox: this.#ports.sandbox,
        code: this.#ports.code,
        ...(reply ? { reply } : {}),
        turnId: this.#input.turnId,
        stepSeq: this.#stepSeq,
        idempotencyKey: `${this.#input.turnId}:${this.#stepSeq}`,
        now: this.#ports.clock.now(),
        deadline: this.#deadline,
      });
    } catch (error) {
      this.#lastStep = { ...location, outcome: "fail" };
      this.#fail(error, location, failurePort);
      return;
    }
    this.#applyStep(result, location, snapshot, { from: "card", failurePort });
  }

  async #runAutonomy(frame: Frame, node: AutonomousNode): Promise<void> {
    const location = { workflowId: frame.workflowId, nodeId: node.id };
    if (!(await this.#beginStep(location))) return;
    const key = `${frame.workflowId}:${node.id}`;
    const resume = this.#resumeFor === node.id ? this.#autonomyResume : undefined;
    this.#autonomyResume = undefined;
    const snapshot = this.#snapshot();
    const autonomy = this.#ports.autonomy;
    let result: StepResult;
    try {
      if (!autonomy)
        throw new AppError(
          "internal_error",
          { requestId: this.#input.turnId },
          { detail: "Autonomous nodes are not available." },
        );
      const stepped = await autonomy.step({
        node,
        location,
        memory: this.#state.autonomy[key],
        ...(resume ? { resume } : {}),
        scopes: this.#scopes(frame),
        turnId: this.#input.turnId,
        stepSeq: this.#stepSeq,
        idempotencyKey: `${this.#input.turnId}:${this.#stepSeq}`,
        deadline: this.#deadline,
      });
      this.#state.autonomy[key] = stepped.memory;
      result = stepped;
    } catch (error) {
      this.#lastStep = { ...location, outcome: "fail" };
      this.#fail(error, location, "error");
      return;
    }
    this.#applyStep(result, location, snapshot, { from: "autonomy", failurePort: "error" });
  }

  async #runExit(frame: Frame, node: Extract<Node, { type: "exit" }>): Promise<void> {
    const location = { workflowId: frame.workflowId, nodeId: node.id };
    const names = Object.keys(node.outputs);
    const results = await evalExpressions(Object.values(node.outputs), this.#scopes(frame), this.#ports.sandbox);
    const outputs: Record<string, Json> = {};
    for (const [i, name] of names.entries()) {
      const r = results[i] as ExpressionResult;
      if (!r.ok) {
        this.#fail(r.error, location);
        return;
      }
      if (r.value !== undefined) outputs[name] = r.value;
    }
    this.#return(outputs, location);
  }

  async #runEnd(frame: Frame, node: Extract<Node, { type: "end" }>): Promise<void> {
    const location = { workflowId: frame.workflowId, nodeId: node.id };
    let reason: string;
    try {
      reason = await renderTemplate(node.reason, this.#scopes(frame), this.#ports.sandbox);
    } catch (error) {
      this.#fail(error, location);
      return;
    }
    this.#end(reason);
  }

  #snapshot(): Snapshot {
    return { state: structuredClone(this.#state), messages: this.#messages.length, events: this.#events.length };
  }

  /** Applies a step's writes, messages and outcome; a step whose writes do not fit changes nothing. */
  #applyStep(
    result: StepResult,
    location: StepLocation,
    snapshot: Snapshot,
    via: { from: "card" | "autonomy"; failurePort: string | undefined },
  ): void {
    const parsed = StepOutcome.safeParse(result.outcome);
    if (!parsed.success) {
      this.#lastStep = { ...location, outcome: "fail" };
      const detail = `The step returned an outcome the engine does not understand: ${parsed.error.message}`;
      this.#fail(new AppError("internal_error", { requestId: this.#input.turnId }, { detail }), location);
      return;
    }
    this.#lastStep = { ...location, outcome: parsed.data.type };
    this.#touch();
    try {
      this.#write(this.#top(), result.writes ?? []);
    } catch (error) {
      this.#fail(error, location, via.failurePort);
      return;
    }
    this.#emitMessages(result.messages ?? []);
    if (result.logs?.length) this.#logs.push(...result.logs);
    if (result.turn) {
      for (const key of Object.keys(this.#turnScope)) delete this.#turnScope[key];
      Object.assign(this.#turnScope, result.turn);
    }
    if (result.inactivityTimeoutMinutes !== undefined)
      this.#state.inactivityTimeoutMinutes = result.inactivityTimeoutMinutes;
    this.#applyOutcome(parsed.data, location, via);
    const tooLarge = stateSizeError(this.#index, this.#state);
    if (tooLarge) {
      // Nothing from this step is kept: the state goes back to how the step found it.
      this.#state = snapshot.state;
      this.#messages.length = snapshot.messages;
      this.#events.length = snapshot.events;
      this.#fail(tooLarge, location);
    }
  }

  #emitMessages(messages: readonly BotMessagePayload[]): void {
    if (messages.length === 0) return;
    this.#messages.push(...messages);
    this.#messageCount += messages.length;
    this.#touch();
  }

  #write(frame: Frame | undefined, writes: readonly VariableWrite[]): void {
    if (writes.length === 0) return;
    const changed = applyWrites(this.#index, { state: this.#state, user: this.#user }, frame, writes);
    if (changed.has("user")) this.#userVarsChanged = true;
  }

  /* ------------------------------------------------------------------ */
  /* Outcomes                                                            */
  /* ------------------------------------------------------------------ */

  #applyOutcome(
    outcome: StepOutcome,
    location: StepLocation,
    via: { from: "card" | "autonomy"; failurePort: string | undefined },
  ): void {
    const frame = this.#top();
    switch (outcome.type) {
      case "next":
        // For an autonomous node, `next` is another iteration of the same node.
        if (via.from === "card") frame.cardIndex++;
        return;
      case "goto":
        this.#goto(outcome.port, location, via.from);
        return;
      case "wait":
        this.#setWait(outcome.wait);
        return;
      case "call":
        this.#call(outcome, location, via.from);
        return;
      case "return":
        this.#return(outcome.outputs, location);
        return;
      case "handoff":
        this.#handoff(outcome);
        return;
      case "end":
        this.#end(outcome.reason);
        return;
      case "fail":
        this.#fail(outcome.error, location, via.failurePort);
        return;
    }
  }

  /**
   * A card names one of its own port keys (`branch:<id>`, `not_found`); an autonomous node names a
   * node port (`exit:<id>`, `error`). An unconnected card port falls through to the next card
   * (ADR-016); an unconnected node port has nowhere to go.
   */
  #goto(port: string, location: StepLocation, from: "card" | "autonomy"): void {
    const frame = this.#top();
    const portId = from === "card" ? `card:${location.cardId}:${port}` : port;
    const target = this.#index.target(frame.workflowId, frame.nodeId, portId);
    if (target) {
      this.#enter(target);
      return;
    }
    if (from === "card") {
      frame.cardIndex++;
      return;
    }
    const node = this.#index.node(frame.workflowId, frame.nodeId);
    this.#fail(new AppError("no_route", { node: node?.name ?? frame.nodeId }), location);
  }

  /** Follows a node's port; an unconnected `next` finishes the frame like `return({})` (§4.4). */
  #follow(node: Node, port: string): void {
    const frame = this.#top();
    const target = this.#index.target(frame.workflowId, node.id, port);
    if (target) this.#enter(target);
    else this.#return({}, { workflowId: frame.workflowId, nodeId: node.id });
  }

  /** Moves the top frame to a node of its workflow, counting the visit. */
  #enter(nodeId: string): void {
    const frame = this.#top();
    frame.nodeId = nodeId;
    frame.cardIndex = 0;
    this.#touch();
    this.#countVisit(frame.workflowId, nodeId);
  }

  #countVisit(workflowId: string, nodeId: string): void {
    const key = `${workflowId}|${nodeId}`;
    const visits = (this.#visits.get(key) ?? 0) + 1;
    this.#visits.set(key, visits);
    if (visits > LIMITS.nodeVisitsPerTurn) {
      const node = this.#index.node(workflowId, nodeId);
      this.#fail(new AppError("node_loop_detected", { node: node?.name ?? nodeId, limit: LIMITS.nodeVisitsPerTurn }), {
        workflowId,
        nodeId,
      });
    }
  }

  #call(outcome: Extract<StepOutcome, { type: "call" }>, location: StepLocation, from: "card" | "autonomy"): void {
    const workflow = this.#index.workflow(outcome.workflowId);
    const entry = this.#index.first(outcome.workflowId, "entry");
    if (workflow?.kind !== "sub" || !entry) {
      const detail = `Workflow ${outcome.workflowId} is missing or has no Entry node.`;
      this.#fail(new AppError("not_found", {}, { detail }), location);
      return;
    }
    const inputs: Record<string, Json> = {};
    try {
      for (const field of workflow.inputs) {
        const value = outcome.inputs[field.name];
        if (value === undefined) {
          if (field.required)
            throw new AppError("workflow_input_missing", { workflow: workflow.name, input: field.name });
          continue;
        }
        checkType(field.name, value, field.type);
        inputs[field.name] = value;
      }
    } catch (error) {
      this.#fail(error, location);
      return;
    }
    // The caller continues after the call card when the sub-workflow returns.
    if (from === "card") this.#top().cardIndex++;
    this.#push(
      {
        workflowId: workflow.id,
        nodeId: entry.id,
        cardIndex: 0,
        vars: {},
        inputs,
        call: { outputs: outcome.outputs, ...(outcome.toolCallId ? { toolCallId: outcome.toolCallId } : {}) },
      },
      location,
    );
  }

  /**
   * Pops the top frame. A called frame hands its outputs to its caller; a trigger frame restores the
   * wait it interrupted; the last frame leaves the conversation idle.
   */
  #return(outputs: Record<string, Json>, location: StepLocation): void {
    const popped = this.#state.stack.pop() as Frame;
    this.#touch();
    if (popped.call) {
      const caller = this.#top();
      if (popped.call.toolCallId) {
        // The autonomous node that called the workflow as a tool sees the result on its next iteration.
        const key = `${caller.workflowId}:${caller.nodeId}`;
        const memory = this.#state.autonomy[key] ?? { iteration: 0, memo: {}, feedback: [] };
        memory.feedback.push({
          kind: "tool_resumed",
          text: JSON.stringify({ toolCallId: popped.call.toolCallId, outputs }),
        });
        this.#state.autonomy[key] = memory;
        return;
      }
      try {
        const writes = Object.entries(popped.call.outputs)
          .filter(([name]) => outputs[name] !== undefined)
          .map(([name, variableId]) => writeFor(this.#index, variableId, outputs[name] as Json));
        this.#write(caller, writes);
      } catch (error) {
        this.#fail(error, location);
      }
      return;
    }
    if (popped.resumeWait) {
      this.#setWait(popped.resumeWait);
      return;
    }
    if (this.#state.stack.length === 0) this.#state.status = "idle";
  }

  #handoff(outcome: Extract<StepOutcome, { type: "handoff" }>): void {
    this.#events.push({
      type: "handoff.requested",
      data: { reason: outcome.reason, summary: outcome.summary, variables: outcome.variables },
    });
    this.#state.stack = [];
    delete this.#state.wait;
    this.#state.status = "handed_off";
    this.#touch();
  }

  /** Ends the conversation: its state is cleared, user variables are kept (End card contract). */
  #end(reason: string): void {
    const known = END_REASONS.has(reason);
    this.#events.push({
      type: "conversation.ended",
      data: known ? { reason: reason as EndReason } : { reason: "completed", detail: reason },
    });
    this.#state = { ...emptyState(), status: "ended" };
    this.#touch();
  }

  /* ------------------------------------------------------------------ */
  /* Error resolution (§4.4 "Errors")                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Resolves a failure, in order: the card's (or autonomous node's) failure port if connected →
   * the workflow's Error handler node → the bot's error workflow → the default: send the bot's
   * error message, emit an `error` event, clear the stack. Limit failures skip to the default.
   */
  #fail(error: unknown, location: StepLocation, failurePort?: string): void {
    const stepError = isStepError(error) ? error : toStepError(error, this.#input.turnId);
    const record = (handledBy: StepFailure["handledBy"]) => {
      this.#failures.push({ ...stepError, location, handledBy });
      this.#touch();
    };
    const frame = this.#state.stack.at(-1);
    if (!BUDGET_CODES.has(stepError.code) && frame) {
      if (failurePort) {
        const portId = location.cardId ? `card:${location.cardId}:${failurePort}` : failurePort;
        const target = this.#index.target(frame.workflowId, location.nodeId, portId);
        if (target && frame.nodeId === location.nodeId) {
          record("port");
          this.#enter(target);
          return;
        }
      }
      if (!this.#handlerUsed) {
        const handler = this.#index.first(frame.workflowId, "error_handler");
        if (handler) {
          this.#handlerUsed = true;
          record("error_handler");
          this.#enter(handler.id);
          return;
        }
        const errorWorkflowId = this.#input.definition.manifest.errorWorkflowId;
        const errorStart = errorWorkflowId ? this.#index.first(errorWorkflowId, "error_handler") : undefined;
        if (errorWorkflowId && errorStart) {
          this.#handlerUsed = true;
          record("error_workflow");
          this.#state.stack = [];
          delete this.#state.wait;
          this.#state.status = "idle";
          this.#push({ workflowId: errorWorkflowId, nodeId: errorStart.id, cardIndex: 0, vars: {}, inputs: {} });
          return;
        }
      }
    }
    record("default");
    this.#unhandled ??= stepError;
    this.#events.push({
      type: "error",
      data: { code: stepError.code, message: stepError.message, retryable: RETRYABLE_CODES.has(stepError.code) },
    });
    this.#state.stack = [];
    delete this.#state.wait;
    this.#state.status = "idle";
    // Rendered when the step commits; rendering is asynchronous and resolution is not.
    this.#pendingErrorMessage = true;
  }

  /* ------------------------------------------------------------------ */
  /* Scopes and commits                                                  */
  /* ------------------------------------------------------------------ */

  #scopes(frame: Frame | undefined): ExpressionScopes {
    return buildScopes({
      index: this.#index,
      state: this.#state,
      user: this.#user,
      frame,
      event: this.#input.event,
      env: this.#input.env,
      turn: this.#turnScope,
    });
  }

  async #flush(): Promise<void> {
    await this.#sendErrorMessage();
    const user: StepCommit["user"] = {};
    if (this.#userVarsChanged) user.vars = structuredClone(this.#user.vars);
    if (this.#attributesChanged) user.attributes = structuredClone(this.#user.attributes);
    const commit: StepCommit = {
      turnId: this.#input.turnId,
      stepSeq: this.#stepSeq,
      state: structuredClone(this.#state),
      messages: this.#messages,
      events: this.#events,
      failures: this.#failures,
      logs: this.#logs,
      ...(user.vars || user.attributes ? { user } : {}),
      ...(this.#lastStep ? { step: this.#lastStep } : {}),
    };
    this.#messages = [];
    this.#events = [];
    this.#failures = [];
    this.#logs = [];
    this.#userVarsChanged = false;
    this.#attributesChanged = false;
    this.#lastStep = undefined;
    this.#dirty = false;
    await this.#ports.commitStep(commit);
    this.#committedSeq = this.#stepSeq;
  }

  /** The default error handling's message, rendered once the failure is known (§4.4). */
  async #sendErrorMessage(): Promise<void> {
    if (!this.#pendingErrorMessage) return;
    this.#pendingErrorMessage = false;
    let text = DEFAULT_ERROR_MESSAGE;
    try {
      const rendered = await renderTemplate(
        this.#input.definition.manifest.settings.errorMessage,
        this.#scopes(undefined),
        this.#ports.sandbox,
      );
      if (rendered.trim() !== "") text = rendered;
    } catch {
      // The bot's error message itself failed; the platform default still tells the user.
    }
    this.#emitMessages([{ type: "text", text, format: "markdown" }]);
  }
}

function isStepError(value: unknown): value is StepError {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Error) &&
    typeof (value as StepError).code === "string" &&
    typeof (value as StepError).message === "string" &&
    typeof (value as StepError).fix === "string"
  );
}

/** The port a card's failure leaves through, if the card has one: `error` (Code) or `failed` (Capture). */
export function cardFailurePort(card: Card): string | undefined {
  if (card.type === "code") return "error";
  if (card.type === "capture") return "failed";
  return undefined;
}
