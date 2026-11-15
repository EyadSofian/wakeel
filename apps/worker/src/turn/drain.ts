import type { Span } from "@wakeel/contracts";
import { type BotDefinition, type Json, mapPayloadCitations, type RetrievalRecord, TurnId } from "@wakeel/contracts";
import {
  acquireConversationLease,
  appendOutbox,
  assembleDraft,
  clearTableReceipts,
  type Database,
  eventsOfTurn,
  finishTurn,
  getConversation,
  getEndUser,
  type InboundEventRecord,
  insertBotMessages,
  type Keyring,
  LeaseLostError,
  listRuntimeTableNames,
  listTurnSpans,
  loadConfigEnv,
  loadVersionDefinition,
  type NewOutboxEvent,
  nextUnprocessedEvent,
  type ObjectStore,
  recordTurnProgress,
  releaseConversationLease,
  renewConversationLease,
  runningTurnFor,
  startTurn,
  type Tx,
  unprocessedEventsAfter,
  updateEndUser,
  upsertSpans,
  versionToRun,
  writeConversation,
} from "@wakeel/db";
import type { KnowledgePort } from "@wakeel/engine";
import {
  type AiPort,
  type AutonomyPort,
  type ClockPort,
  type CodePort,
  type EnginePorts,
  jsonBytes,
  runTurn,
  type SandboxPort,
  type StepCommit,
  type TablePort,
  type TurnResult,
  toStepError,
} from "@wakeel/engine";
import {
  countMetric,
  type Logger,
  observeMetric,
  type TraceBefore,
  TraceBuilder,
  type TraceContext,
} from "@wakeel/telemetry";
import type { AutonomyTurn } from "./autonomy";
import { eventScope, isTextMessage } from "./event-scope";
import { botMessageId } from "./message-id";
import { scrubSecrets } from "./redact";
import { replayCodePort, replayPolicy } from "./replay";
import { type TableOperationTrace, turnTables } from "./tables";
import { storeTraceSpans } from "./trace-storage";
import { migrateToVersion } from "./version";

/** ADR-008: a lease lasts 30 s and a heartbeat renews it every 10 s. */
export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 10_000;

export interface TurnDeps {
  db: Database;
  /** Identifies this worker in `conversations.lease_owner`. */
  owner: string;
  logger: Logger;
  /** The engine's sandbox ports for one turn (a capability token is minted per exec). */
  enginePorts(turn: {
    workspaceId: string;
    conversationId: string;
    turnId: string;
    knowledge?: KnowledgePort;
    tables: { names: string[]; execute: TablePort["execute"] };
  }): {
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
  traceStore?: Pick<ObjectStore, "put">;
  tracePiiPatterns?: readonly RegExp[];
  /** Writes trace spans; defaults to `upsertSpans`. Tests pass one that fails. */
  writeSpans?(workspaceId: string, spans: readonly Span[]): Promise<void>;
  /**
   * Adds a `webhook` job for the conversation (task 5.2, ADR-028 §4), called after a commit that
   * created deliveries. Optional: without it the janitor still finds them.
   */
  enqueueWebhook?(conversationId: string): Promise<void>;
  /**
   * The Autonomous Node for one turn (task 6.6). Absent: reaching an Autonomous Node fails the step
   * with a clear code, as before the model layer existed.
   */
  autonomy?(turn: AutonomyTurn, code: CodePort, knowledge?: KnowledgePort, tables?: TablePort): AutonomyPort;
  knowledge?(turn: AutonomyTurn, record: (trace: RetrievalRecord) => void): KnowledgePort;
  /** Writes handoff summaries (task 5.4). Absent: summaries are empty. */
  summarizeHandoff?(input: HandoffSummaryInput): Promise<string>;
  /** The model layer for AI cards (task 6.7). Absent: AI cards fail with `model_not_configured`. */
  ai?(turn: AutonomyTurn): AiPort;
  /**
   * Opens config variable values (task 7.3). Absent: `env` is empty, as before config variables
   * existed.
   */
  keyring?: Keyring;
}

/** What the worker's handoff summarizer is asked for (task 5.4); `model` is the bot's utility model. */
export interface HandoffSummaryInput {
  workspaceId: string;
  conversationId: string;
  reason: string;
  model: string;
  botId: string;
  turnId: string;
  mode: AutonomyTurn["mode"];
}

/** The turn span's trigger for each inbound kind (ADR-026). */
const TRIGGERS: Record<string, TraceContext["trigger"]> = {
  message: "message",
  event: "event",
  user_update: "user_update",
  tool_result: "tool_result",
  handoff_release: "handoff_release",
  timeout: "timeout",
  run_from: "run_from",
  end: "end",
};

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
    if (epoch === undefined) {
      countMetric("wakeel_lease_contention_total");
      return { turns: total, stopped: "leased_elsewhere" };
    }
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
  /** The open turn's trace (task 4.7) and the values before the next step, for its variable diff. */
  #trace: TraceBuilder | undefined;
  #before: TraceBefore | undefined;
  /** Plaintext of this turn's secret config values, scrubbed from every span (task 7.3). */
  #secrets: readonly string[] = [];

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
      const turn = await runningTurnFor(tx, event.id);
      // A resumed turn finishes on the version it started with; a new one first follows a publish.
      const migrated = turn ? undefined : await followPublishedVersion(tx, this.conversationId, this.epoch);
      const conversation = await getConversation(tx, this.conversationId);
      const definition = await loadDefinition(tx, conversation.botId, conversation.versionId);
      // A published version runs with production values; the draft with draft values (ADR-037).
      const config = this.deps.keyring
        ? await loadConfigEnv(
            tx,
            this.deps.keyring,
            this.workspaceId,
            conversation.botId,
            conversation.versionId ? "production" : "draft",
          )
        : { values: {}, secrets: [] };
      return { event, conversation, definition, turn, migrated, config };
    });
    if (!loaded) return false;
    const { event, conversation, definition, migrated, config } = loaded;
    const replay = replayPolicy(conversation.mode, event.payload);
    this.#secrets = config.secrets;

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
    // The trace (ADR-026): a resumed turn continues from the spans the last worker stored.
    const turnId = turn.id;
    const stored = loaded.turn
      ? await this.#tx((tx) => listTurnSpans(tx, turnId)).catch((err: unknown) => {
          log.warn({ err }, "trace read failed; the resumed trace starts again");
          return [] as Span[];
        })
      : [];
    this.#trace = new TraceBuilder(
      {
        workspaceId: this.workspaceId,
        botId: conversation.botId,
        conversationId: this.conversationId,
        turnId,
        mode: conversation.mode as TraceContext["mode"],
        trigger: TRIGGERS[event.kind] ?? "event",
        versionId: conversation.versionId,
      },
      definition,
      stored,
    );
    this.#before = { state, user: { vars: user.vars, attributes: user.attributes } };
    await this.#writeSpans(this.#trace.turnStarted(new Date(clock.now())));
    if (migrated) await this.#writeSpans(this.#trace.versionMigrated(migrated, new Date(clock.now())));
    const summarize = this.deps.summarizeHandoff;
    const modelTurn: AutonomyTurn = {
      workspaceId: this.workspaceId,
      conversationId: this.conversationId,
      botId: conversation.botId,
      turnId: turn.id,
      mode: conversation.mode as AutonomyTurn["mode"],
      definition,
      ...(state.summary ? { summary: state.summary.text } : {}),
      env: config.values,
      ...(replay ? { replay: { allowSideEffects: replay.allowSideEffects } } : {}),
    };
    const retrievalTraces: RetrievalRecord[] = [];
    const knowledge = this.deps.knowledge?.(modelTurn, (record) => retrievalTraces.push(record));
    const tableOps: TableOperationTrace[] = [];
    const tableNames = await this.#tx((tx) => listRuntimeTableNames(tx, conversation.botId));
    const tables = turnTables(this.deps.db, { ...modelTurn, epoch: this.epoch }, (op) => tableOps.push(op));
    const sandbox = this.deps.enginePorts({
      workspaceId: this.workspaceId,
      conversationId: this.conversationId,
      turnId: turn.id,
      ...(knowledge ? { knowledge } : {}),
      tables: { names: tableNames, execute: tables.execute },
    });
    const autonomy = this.deps.autonomy?.(modelTurn, sandbox.code, knowledge, tables);
    const ai = this.deps.ai?.(modelTurn);
    const ports: EnginePorts = {
      ...sandbox,
      ...(replay ? { code: replayCodePort(sandbox.code, replay.allowSideEffects) } : {}),
      tables,
      ...(knowledge ? { knowledge } : {}),
      ...(autonomy ? { autonomy } : {}),
      ...(ai ? { ai } : {}),
      clock,
      ...(summarize
        ? {
            handoffSummary: ({ reason }) =>
              summarize({
                workspaceId: this.workspaceId,
                conversationId: this.conversationId,
                reason,
                model: definition.manifest.settings.models.utility,
                botId: conversation.botId,
                turnId: turn.id,
                mode: modelTurn.mode,
              }),
          }
        : {}),
      commitStep: (commit) =>
        this.#commitStep(
          {
            ...commit,
            ...(retrievalTraces.length ? { retrieval: retrievalTraces.splice(0) } : {}),
            ...(tableOps.length ? { tableOps: tableOps.splice(0) } : {}),
          },
          conversation,
          turn.id,
        ),
      emitEphemeral: async (e) => {
        await this.#tx((tx) =>
          this.#appendOutbox(tx, conversation, [
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
          env: config.values,
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
        await this.#appendOutbox(tx, conversation, [
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
        await this.#appendOutbox(tx, conversation, [
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
        if (conversation.mode === "live") await clearTableReceipts(tx, turn.id);
      });
    }

    observeMetric("wakeel_turn_duration_seconds", { mode: modelTurn.mode }, durationMs / 1000);
    await this.#writeSpans(
      this.#trace.turnFinished(
        { status: result?.status ?? "failed", stepSeq: result?.stepSeq ?? turn.stepCount },
        new Date(clock.now()),
      ),
    );
    this.#trace = undefined;
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
    const replay = replayPolicy("emulator", event.payload);
    if (replay) {
      const following = await this.#tx((tx) => unprocessedEventsAfter(tx, this.conversationId, event.seq));
      return [event, ...following.filter((next) => replayPolicy("emulator", next.payload)?.group === replay.group)];
    }
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

  /**
   * Writes spans outside any step transaction (ADR-009): a failing trace store is logged and the
   * turn goes on. Readers are told afterwards with the step's own notification.
   */
  async #writeSpans(written: readonly Span[]): Promise<void> {
    if (written.length === 0) return;
    // The redaction set (task 7.3): no secret config value is ever stored in a span.
    const spans = scrubSecrets(written, this.#secrets);
    try {
      if (this.deps.writeSpans) await this.deps.writeSpans(this.workspaceId, spans);
      else if (this.deps.traceStore) {
        await storeTraceSpans(
          this.deps.db,
          this.deps.traceStore,
          this.workspaceId,
          written,
          this.#secrets,
          this.deps.tracePiiPatterns ?? [],
          () => this.#log.warn({ code: "trace_payload_write_failed" }, "trace payload was not stored"),
        );
      } else await this.#tx((tx) => upsertSpans(tx, spans));
    } catch {
      countMetric("wakeel_trace_failures_total", { reason: "write" });
      this.#log.warn({ spans: spans.length, code: "trace_write_failed" }, "trace spans were not written");
    }
  }

  /** Best-effort: SSE readers also poll, so a lost notification only delays them. */
  async #notify(): Promise<void> {
    await this.#wakeWebhooks();
    await this.deps
      .publish(conversationEventsChannel(this.conversationId), "")
      .catch((err: unknown) => this.#log.warn({ err }, "conversation-events publish failed"));
  }

  /** Deliveries created by commits whose `webhook` job is not enqueued yet. */
  #deliveriesCreated = 0;

  /** `appendOutbox` with this conversation's fence and clock, counting the deliveries it creates. */
  async #appendOutbox(tx: Tx, conversation: { connectionId: string }, events: readonly NewOutboxEvent[]) {
    const at = new Date((this.deps.clock ?? Date).now());
    this.#deliveriesCreated += await appendOutbox(
      tx,
      { conversationId: this.conversationId, connectionId: conversation.connectionId, epoch: this.epoch, at },
      events,
    );
  }

  /** Best-effort, after the commit: the janitor finds deliveries whose job was never added. */
  async #wakeWebhooks(): Promise<void> {
    if (this.#deliveriesCreated === 0 || !this.deps.enqueueWebhook) return;
    this.#deliveriesCreated = 0;
    await this.deps
      .enqueueWebhook(this.conversationId)
      .catch((err: unknown) => this.#log.warn({ err }, "webhook enqueue failed"));
  }

  /** One step, one transaction (§4.4 "Persistence"): state, messages, outbox, user, step counter. */
  async #commitStep(
    commit: StepCommit & { tableOps?: TableOperationTrace[] },
    conversation: { connectionId: string; endUserId: string; mode: string },
    turnId: string,
  ) {
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
      const outgoing = commit.messages.map((payload) =>
        mapPayloadCitations(payload, commit.state.retrievalCitations?.sources ?? {}),
      );
      const stored = await insertBotMessages(
        tx,
        this.conversationId,
        outgoing.map((m, i) => ({
          id: botMessageId(turnId, commit.stepSeq, i),
          type: m.payload.type,
          payload: m.payload as unknown as Record<string, Json>,
          citations: m.citations,
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
              payload: outgoing[i]?.payload as unknown as Json,
              citations: outgoing[i]?.citations ?? [],
              turnId,
              createdAt: row.createdAt.toISOString(),
            },
          },
        },
      }));
      for (const e of commit.events)
        outbox.push({ type: e.type, payload: { turnId, data: e.data as unknown as Json } });
      await this.#appendOutbox(tx, conversation, outbox);
      if (commit.user) await updateEndUser(tx, conversation.endUserId, commit.user);
      await recordTurnProgress(tx, turnId, commit.stepSeq);
      if (conversation.mode === "live") await clearTableReceipts(tx, turnId, commit.stepSeq);
    });
    // The step's spans, after its commit: an uncommitted step never appears in the trace.
    if (this.#trace && this.#before) {
      await this.#writeSpans(
        this.#trace.stepCommitted(commit, this.#before, new Date((this.deps.clock ?? Date).now())),
      );
      this.#before = {
        state: commit.state,
        user: {
          vars: commit.user?.vars ?? this.#before.user.vars,
          attributes: commit.user?.attributes ?? this.#before.user.attributes,
        },
      };
    }
    await this.#notify();
  }
}

/**
 * Moves a live conversation on a production connection to the bot's published version when it differs
 * from the one it is pinned to (architecture §3.2, task 7.2), and returns what to record in the
 * trace. Nothing happens for draft conversations or before the first publish.
 */
async function followPublishedVersion(
  tx: Tx,
  conversationId: string,
  epoch: number,
): Promise<Extract<Span, { kind: "version.migrated" }>["attrs"] | undefined> {
  const conversation = await getConversation(tx, conversationId);
  const run = await versionToRun(tx, conversation);
  // Emulator and eval conversations run what they were started on, even on a production connection.
  if (
    conversation.mode !== "live" ||
    run.target !== "production" ||
    !run.publishedVersionId ||
    run.publishedVersionId === conversation.versionId
  )
    return undefined;
  const next = await loadVersionDefinition(tx, run.publishedVersionId);
  const previous = conversation.versionId ? await loadVersionDefinition(tx, conversation.versionId) : undefined;
  const user = await getEndUser(tx, conversation.endUserId);
  const m = migrateToVersion({
    state: conversation.state,
    userVars: user.vars,
    next,
    ...(previous ? { previous } : {}),
  });
  await writeConversation(tx, conversationId, epoch, {
    versionId: run.publishedVersionId,
    ...(m.positionKept ? {} : { state: m.state, stateBytes: Buffer.byteLength(JSON.stringify(m.state)) }),
  });
  if (m.dropped.some((d) => d.scope === "user")) await updateEndUser(tx, conversation.endUserId, { vars: m.userVars });
  return {
    fromVersionId: conversation.versionId,
    toVersionId: run.publishedVersionId,
    positionKept: m.positionKept,
    dropped: m.dropped,
  };
}

/**
 * The definition a conversation runs: its pinned version, or the draft when it has none (emulator
 * conversations and `target=draft` connections, architecture §3.2).
 */
async function loadDefinition(tx: Tx, botId: string, versionId: string | null): Promise<BotDefinition> {
  return versionId === null ? assembleDraft(tx, botId) : loadVersionDefinition(tx, versionId);
}
