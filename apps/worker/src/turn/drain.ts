import {
  AppError,
  type BotDefinition,
  BotDefinition as BotDefinitionSchema,
  type BotManifest,
  type Json,
  TurnId,
  type Workflow,
} from "@wakeel/contracts";
import {
  acquireConversationLease,
  appendOutbox,
  type Database,
  eventsOfTurn,
  finishTurn,
  getConversation,
  getEndUser,
  type InboundEventRecord,
  insertBotMessages,
  LeaseLostError,
  listDraftDocs,
  type NewOutboxEvent,
  nextUnprocessedEvent,
  recordTurnProgress,
  releaseConversationLease,
  renewConversationLease,
  runningTurnFor,
  startTurn,
  type Tx,
  unprocessedEventsAfter,
  updateEndUser,
  writeConversation,
} from "@wakeel/db";
import {
  type ClockPort,
  type CodePort,
  type EnginePorts,
  jsonBytes,
  runTurn,
  type SandboxPort,
  type StepCommit,
  type TurnResult,
  toStepError,
} from "@wakeel/engine";
import type { Logger } from "@wakeel/telemetry";
import { eventScope, isTextMessage } from "./event-scope";
import { botMessageId } from "./message-id";

/** ADR-008: a lease lasts 30 s and a heartbeat renews it every 10 s. */
export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 10_000;

export interface TurnDeps {
  db: Database;
  /** Identifies this worker in `conversations.lease_owner`. */
  owner: string;
  logger: Logger;
  /** The engine's sandbox ports for one turn (a capability token is minted per exec). */
  enginePorts(turn: { workspaceId: string; conversationId: string; turnId: string }): {
    sandbox: SandboxPort;
    code: CodePort;
  };
  /** Redis PUBLISH, for `turn-done:<conversationId>:<seq>` (§4.2, §9.3). */
  publish(channel: string, message: string): Promise<void>;
  clock?: ClockPort;
  /** Waits out the coalescing window. Tests pass their own. */
  sleep?(ms: number): Promise<void>;
  leaseMs?: number;
  /** 0 turns the heartbeat off (tests that simulate a dead worker). */
  heartbeatMs?: number;
}

export interface DrainResult {
  /** Turns finished by this call. */
  turns: number;
  /** Why it stopped. */
  stopped: "drained" | "leased_elsewhere" | "lease_lost" | "not_found";
}

export const turnDoneChannel = (conversationId: string, seq: number) => `turn-done:${conversationId}:${seq}`;

/** Published after every commit that wrote outbox rows, so SSE readers fetch them at once (§9.3). */
export const conversationEventsChannel = (conversationId: string) => `conversation-events:${conversationId}`;

/** The turn id the Bridge API minted for this event and returned in its 202, if it is a valid one. */
function plannedTurnId(event: InboundEventRecord): string | undefined {
  const id = event.payload["turnId"];
  return typeof id === "string" && TurnId.safeParse(id).success ? id : undefined;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Processes a conversation's inbox (architecture §4.3): takes the lease, then runs one turn per
 * unprocessed inbound event, oldest first, until none is left. Every step commits in its own
 * transaction fenced by the lease epoch, so a worker that lost the lease stops without writing.
 * A turn a dead worker left running is resumed at its first uncommitted step.
 */
export async function drainConversation(deps: TurnDeps, conversationId: string): Promise<DrainResult> {
  const workspaceId = await deps.db.lookup.conversationWorkspace(conversationId);
  if (!workspaceId) return { turns: 0, stopped: "not_found" };
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  let total = 0;
  // A message can arrive between the last read of the inbox and the release; look again then.
  for (let round = 0; round < 3; round++) {
    const epoch = await deps.db.withWorkspace(workspaceId, (tx) =>
      acquireConversationLease(tx, conversationId, deps.owner, leaseMs),
    );
    if (epoch === undefined) return { turns: total, stopped: "leased_elsewhere" };
    const run = new ConversationRun(deps, workspaceId, conversationId, epoch);
    const outcome = await run.drain();
    total += outcome.turns;
    if (outcome.stopped === "lease_lost") return { turns: total, stopped: "lease_lost" };
    const more = await deps.db.withWorkspace(workspaceId, (tx) => nextUnprocessedEvent(tx, conversationId));
    if (!more) break;
  }
  return { turns: total, stopped: "drained" };
}

class ConversationRun {
  readonly #log: Logger;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(
    readonly deps: TurnDeps,
    readonly workspaceId: string,
    readonly conversationId: string,
    readonly epoch: number,
  ) {
    this.#log = deps.logger.child({ conversationId, workspaceId, leaseEpoch: epoch });
  }

  #tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.deps.db.withWorkspace(this.workspaceId, fn);
  }

  async drain(): Promise<{ turns: number; stopped: "drained" | "lease_lost" }> {
    this.#startHeartbeat();
    let turns = 0;
    try {
      for (;;) {
        const done = await this.#nextTurn();
        if (!done) break;
        turns++;
      }
      await this.#tx((tx) => releaseConversationLease(tx, this.conversationId, this.epoch));
      return { turns, stopped: "drained" };
    } catch (error) {
      if (error instanceof LeaseLostError) {
        this.#log.warn("lease lost to another worker; stopping without further writes");
        return { turns, stopped: "lease_lost" };
      }
      throw error;
    } finally {
      if (this.#heartbeat) clearInterval(this.#heartbeat);
    }
  }

  #startHeartbeat(): void {
    const every = this.deps.heartbeatMs ?? HEARTBEAT_MS;
    if (every <= 0) return;
    this.#heartbeat = setInterval(() => {
      void this.#tx((tx) =>
        renewConversationLease(tx, this.conversationId, this.epoch, this.deps.leaseMs ?? LEASE_MS),
      ).catch((err: unknown) => this.#log.error({ err }, "lease heartbeat failed"));
    }, every);
    this.#heartbeat.unref();
  }

  /** Runs the turn for the oldest unprocessed event. False when the inbox is empty. */
  async #nextTurn(): Promise<boolean> {
    const loaded = await this.#tx(async (tx) => {
      const event = await nextUnprocessedEvent(tx, this.conversationId);
      if (!event) return undefined;
      const conversation = await getConversation(tx, this.conversationId);
      const definition = await loadDefinition(tx, conversation.botId, conversation.versionId);
      const turn = await runningTurnFor(tx, event.id);
      return { event, conversation, definition, turn };
    });
    if (!loaded) return false;
    const { event, conversation, definition } = loaded;

    let turn = loaded.turn;
    if (!turn) {
      const group = await this.#coalesce(event, definition);
      turn = await this.#tx((tx) =>
        startTurn(tx, {
          conversationId: this.conversationId,
          botId: conversation.botId,
          versionId: conversation.versionId,
          epoch: this.epoch,
          eventIds: group.map((e) => e.id),
          ...(plannedTurnId(event) ? { id: plannedTurnId(event) } : {}),
        }),
      );
    }
    const { events, user, state } = await this.#tx(async (tx) => ({
      events: await eventsOfTurn(tx, (turn as { id: string }).id),
      user: await getEndUser(tx, conversation.endUserId),
      state: (await getConversation(tx, this.conversationId)).state,
    }));
    const log = this.#log.child({ turnId: turn.id, eventSeq: event.seq, resumedAt: turn.stepCount || undefined });
    log.info("turn started");

    const clock = this.deps.clock ?? { now: () => Date.now() };
    const sandbox = this.deps.enginePorts({
      workspaceId: this.workspaceId,
      conversationId: this.conversationId,
      turnId: turn.id,
    });
    const ports: EnginePorts = {
      ...sandbox,
      clock,
      commitStep: (commit) => this.#commitStep(commit, conversation, turn.id),
      emitEphemeral: async (e) => {
        await this.#tx((tx) =>
          appendOutbox(tx, this.#outboxAt(conversation), [
            { type: e.type, payload: { turnId: turn.id, data: e.data } as Record<string, Json>, ephemeral: true },
          ]),
        );
        await this.#notify();
      },
    };

    let result: TurnResult | undefined;
    let crash: unknown;
    try {
      result = await runTurn(
        {
          turnId: turn.id,
          definition,
          state,
          event: eventScope(events, conversation, user),
          user: { vars: user.vars, attributes: user.attributes },
          // Config variable values arrive with task 7.3.
          env: {},
          startedAt: turn.startedAt.getTime(),
          committedSteps: turn.stepCount,
        },
        ports,
      );
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      crash = error;
    }

    const durationMs = Math.max(0, Math.round(clock.now() - turn.startedAt.getTime()));
    const touch = event.kind === "message" || event.kind === "event";
    const timeout = result?.state.inactivityTimeoutMinutes ?? definition.manifest.settings.inactivityTimeoutMinutes;
    if (result) {
      await this.#tx(async (tx) => {
        await writeConversation(tx, this.conversationId, this.epoch, { touchActivity: touch, timeoutMinutes: timeout });
        await appendOutbox(tx, this.#outboxAt(conversation), [
          {
            type: "turn.completed",
            payload: {
              turnId: turn.id,
              data: { status: result.status, messageCount: result.messageCount, durationMs },
            },
          },
        ]);
        await finishTurn(tx, {
          turnId: turn.id,
          status: result.status,
          stepCount: result.stepSeq,
          ...(result.error ? { error: { ...result.error } } : {}),
        });
      });
      log.info({ status: result.status, steps: result.stepSeq, durationMs }, "turn finished");
    } else {
      // A defect, not a builder error: never leave the event to be retried forever (CLAUDE.md §9).
      const error = toStepError(crash, turn.id);
      log.error({ err: crash, code: error.code }, "turn crashed");
      await this.#tx(async (tx) => {
        await writeConversation(tx, this.conversationId, this.epoch, { touchActivity: touch });
        await appendOutbox(tx, this.#outboxAt(conversation), [
          {
            type: "error",
            payload: { turnId: turn.id, data: { code: error.code, message: error.message, retryable: true } },
          },
          {
            type: "turn.completed",
            payload: { turnId: turn.id, data: { status: "failed", messageCount: 0, durationMs } },
          },
        ]);
        await finishTurn(tx, { turnId: turn.id, status: "failed", stepCount: turn.stepCount, error: { ...error } });
      });
    }

    await this.#notify();
    const status = result?.status ?? "failed";
    for (const e of events) {
      await this.deps
        .publish(turnDoneChannel(this.conversationId, e.seq), JSON.stringify({ turnId: turn.id, status }))
        .catch((err: unknown) => log.warn({ err }, "turn-done publish failed"));
    }
    return true;
  }

  /**
   * Coalescing (§4.3): when the bot asks for it and the event is a text message, wait the window and
   * take every text message that followed it without anything else in between.
   */
  async #coalesce(event: InboundEventRecord, definition: BotDefinition): Promise<InboundEventRecord[]> {
    const windowMs = definition.manifest.settings.coalesceWindowMs;
    if (windowMs <= 0 || !isTextMessage(event)) return [event];
    await (this.deps.sleep ?? realSleep)(windowMs);
    const following = await this.#tx((tx) => unprocessedEventsAfter(tx, this.conversationId, event.seq));
    const group = [event];
    for (const next of following) {
      if (next.seq !== (group.at(-1) as InboundEventRecord).seq + 1 || !isTextMessage(next)) break;
      group.push(next);
    }
    return group;
  }

  /** Best-effort: SSE readers also poll, so a lost notification only delays them. */
  async #notify(): Promise<void> {
    await this.deps
      .publish(conversationEventsChannel(this.conversationId), "")
      .catch((err: unknown) => this.#log.warn({ err }, "conversation-events publish failed"));
  }

  #outboxAt(conversation: { connectionId: string }) {
    return { conversationId: this.conversationId, connectionId: conversation.connectionId, epoch: this.epoch };
  }

  /** One step, one transaction (§4.4 "Persistence"): state, messages, outbox, user, step counter. */
  async #commitStep(commit: StepCommit, conversation: { connectionId: string; endUserId: string }, turnId: string) {
    await this.#tx(async (tx) => {
      const ended = commit.events.find((e) => e.type === "conversation.ended");
      const handoff = commit.events.find((e) => e.type === "handoff.requested");
      await writeConversation(tx, this.conversationId, this.epoch, {
        state: commit.state,
        stateBytes: jsonBytes(commit.state),
        endedReason:
          commit.state.status === "ended"
            ? ended?.type === "conversation.ended"
              ? ended.data.reason
              : "completed"
            : null,
        handoff:
          commit.state.status === "handed_off" && handoff?.type === "handoff.requested"
            ? (handoff.data as unknown as Record<string, Json>)
            : commit.state.status === "handed_off"
              ? undefined
              : null,
      });
      const stored = await insertBotMessages(
        tx,
        this.conversationId,
        commit.messages.map((m, i) => ({
          id: botMessageId(turnId, commit.stepSeq, i),
          type: m.type,
          payload: m as unknown as Record<string, Json>,
          turnId,
        })),
      );
      const outbox: NewOutboxEvent[] = stored.map((row, i) => ({
        type: "message.created",
        payload: {
          turnId,
          data: {
            message: {
              id: row.id,
              conversationId: this.conversationId,
              seq: row.seq,
              direction: "out",
              payload: commit.messages[i] as unknown as Json,
              citations: [],
              turnId,
              createdAt: row.createdAt.toISOString(),
            },
          },
        },
      }));
      for (const e of commit.events)
        outbox.push({ type: e.type, payload: { turnId, data: e.data as unknown as Json } });
      await appendOutbox(tx, this.#outboxAt(conversation), outbox);
      if (commit.user) await updateEndUser(tx, conversation.endUserId, commit.user);
      await recordTurnProgress(tx, turnId, commit.stepSeq);
    });
    await this.#notify();
  }
}

/**
 * The definition a conversation runs. Until versions exist (task 7.1) every conversation runs the
 * bot's draft, as emulator conversations and `target=draft` connections do (§3.2).
 */
async function loadDefinition(tx: Tx, botId: string, versionId: string | null): Promise<BotDefinition> {
  if (versionId !== null)
    throw new AppError("internal_error", {}, { detail: "Published versions arrive with task 7.1." });
  const docs = await listDraftDocs(tx, botId);
  const manifest = docs.find((d) => d.kind === "manifest")?.doc as BotManifest | undefined;
  if (!manifest) throw new AppError("not_found", {}, { detail: `Bot ${botId} has no draft manifest.` });
  return BotDefinitionSchema.parse({
    schemaVersion: 1,
    manifest,
    workflows: docs.filter((d) => d.kind === "workflow").map((d) => d.doc as Workflow),
  });
}
