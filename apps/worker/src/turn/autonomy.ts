import type { ToolCodeRunner } from "@wakeel/autonomy";
import {
  type AutonomyCode,
  type AutonomyContext,
  type AutonomyStepInput,
  callTool,
  createAutonomy,
  isToolSuspended,
  type PendingToolCall,
  type RunOutcome,
} from "@wakeel/autonomy";
import {
  AppError,
  type AutonomousNode,
  type BotDefinition,
  type Json,
  type ModelProvider,
  modelBaseUrlSecret,
  modelKeySecret,
  type Tool,
} from "@wakeel/contracts";
import {
  type Database,
  getWorkspace,
  insertUsageEvent,
  type Keyring,
  readSecretValue,
  recentTranscript,
} from "@wakeel/db";
import type { AutonomyPort, CodePort } from "@wakeel/engine";
import type { LlmClient, UsageEvent } from "@wakeel/llm";
import type { AutonomyRunPort, BuilderTool } from "@wakeel/sandbox-client";
import type { Logger } from "@wakeel/telemetry";

/**
 * The worker side of the Autonomous Node (task 6.6, ADR-032): the model resolved for the node, the
 * workspace's own provider key (BYOK), one usage event per call, the transcript, and the `:::run`
 * block in the sandbox with the node's tools answered here. The loop itself is `@wakeel/autonomy`.
 */

/** How many recent messages the prompt builder may window over (ADR-031 §2 trims them by tokens). */
const TRANSCRIPT_MESSAGES = 60;
/** A run block may not outlast the turn, nor the sandbox's own ceiling. */
const RUN_MAX_MS = 30_000;
const RUN_MEMORY_MB = 64;

export interface AutonomyTurn {
  workspaceId: string;
  conversationId: string;
  botId: string;
  turnId: string;
  mode: "live" | "emulator" | "eval";
  definition: BotDefinition;
  /** The rolling summary in the conversation's state, if any. */
  summary?: string;
  env: Record<string, Json>;
}

export interface AutonomyWiring {
  db: Database;
  llm: LlmClient;
  /** Runs the model's code (`kind: "autonomy_run"`). */
  runPort: AutonomyRunPort;
  logger: Logger;
  now?: () => number;
}

/**
 * The model for a node (architecture §7): the node's own, then the bot's default, then the
 * workspace's. A model reference is `provider:id`; the registry knows models by id.
 */
export function resolveModel(
  node: AutonomousNode,
  definition: BotDefinition,
  workspaceDefault: string | undefined,
): string {
  const ref = node.model ?? definition.manifest.settings.models.default ?? workspaceDefault;
  if (!ref) throw new AppError("model_not_configured", {});
  const colon = ref.indexOf(":");
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/** BYOK (architecture §7): a workspace's provider key from `workspace_secrets`. */
export function workspaceCredentials(db: Database, keyring: Keyring) {
  return {
    async workspaceKey(workspaceId: string, provider: ModelProvider) {
      return db.withWorkspace(workspaceId, async (tx) => {
        const key = await readSecretValue(tx, keyring, workspaceId, modelKeySecret(provider));
        if (!key) return undefined;
        const baseUrl =
          provider === "openai-compatible"
            ? await readSecretValue(tx, keyring, workspaceId, modelBaseUrlSecret(provider))
            : undefined;
        return { apiKey: key.reveal(), ...(baseUrl ? { baseUrl: baseUrl.reveal() } : {}) };
      });
    },
    // No plan offers platform keys yet (Phase 13): every workspace brings its own.
    platformKey: async () => undefined,
    platformKeysAllowed: async () => false,
  };
}

/** Writes one `usage_events` row per model call (task 6.1). */
export function recordUsage(db: Database) {
  return async (e: UsageEvent) => {
    await db.withWorkspace(e.workspaceId, (tx) =>
      insertUsageEvent(tx, {
        kind: e.kind,
        quantity: e.usage.inputTokens + e.usage.cachedInputTokens + e.usage.cacheWriteTokens + e.usage.outputTokens,
        unit: "tokens",
        model: e.model,
        costMicroUsd: e.costMicroUsd,
        mode: e.mode,
        ...(e.botId ? { botId: e.botId } : {}),
        ...(e.conversationId ? { conversationId: e.conversationId } : {}),
        ...(e.turnId ? { turnId: e.turnId } : {}),
        detail: { ...e.usage, provider: e.provider, keySource: e.keySource, purpose: e.purpose },
      }),
    );
  };
}

/** The engine's `AutonomyPort` for one turn. */
export function autonomyPort(w: AutonomyWiring, turn: AutonomyTurn, code: CodePort): AutonomyPort {
  const now = w.now ?? Date.now;
  let workspaceDefault: Promise<string | undefined> | undefined;
  const defaultModel = () => {
    workspaceDefault ??= w.db
      .withWorkspace(turn.workspaceId, (tx) => getWorkspace(tx))
      .then((ws) => ws.settings.defaultModel);
    return workspaceDefault;
  };

  const context = async (_input: AutonomyStepInput): Promise<AutonomyContext> => {
    const rows = await w.db.withWorkspace(turn.workspaceId, (tx) =>
      recentTranscript(tx, turn.conversationId, TRANSCRIPT_MESSAGES),
    );
    return {
      definition: turn.definition,
      bot: { name: turn.definition.manifest.name },
      env: turn.env,
      transcript: rows.map((r) => ({ direction: r.direction, payload: r.payload })),
      ...(turn.summary ? { summary: turn.summary } : {}),
      now: new Date(now()).toISOString(),
    };
  };

  const run: AutonomyCode = {
    async run(request) {
      const timeoutMs = Math.max(1_000, Math.min(RUN_MAX_MS, request.deadline - now()));
      // A workflow tool ends the block at the call site (ADR-035 §1): the call is never answered and
      // the exec is stopped, so nothing after it runs, tool calls included.
      const stop = new AbortController();
      let suspended: PendingToolCall | undefined;
      let outcome: Awaited<ReturnType<AutonomyRunPort["run"]>>;
      try {
        outcome = await w.runPort.run({
          source: request.source,
          scopes: request.scopes,
          tools: request.node.tools.map(manifestEntry),
          timeoutMs,
          memoryMb: RUN_MEMORY_MB,
          idempotencyKey: request.idempotencyKey,
          signal: stop.signal,
          onTool: async (call) => {
            if (suspended) throw new AppError("tool_failed", { tool: call.tool, message: "the block already ended" });
            try {
              return await callTool(request.node, call, {
                definition: turn.definition,
                code: toolCode(code),
                scopes: request.scopes,
                idempotencyKey: request.idempotencyKey,
                warn: (message, data) => w.logger.warn(data, message),
              });
            } catch (error) {
              if (!isToolSuspended(error)) throw error;
              suspended = error.pending;
              stop.abort(error);
              return new Promise<never>(() => {});
            }
          },
        });
      } catch (error) {
        if (suspended) return { ok: false, suspended } satisfies RunOutcome;
        throw error;
      }
      if (suspended) return { ok: false, suspended } satisfies RunOutcome;
      const logs = outcome.logs.map((l) => ({ level: l.level, message: l.args.map(logText).join(" ") }));
      if (!outcome.ok) {
        // A sandbox failure that is not the code's own is ours: never hand it to the model as its bug.
        if (outcome.code === "internal_error") throw new AppError("internal_error", {}, { detail: outcome.message });
        return {
          ok: false,
          error: { message: outcome.message, ...(outcome.line !== undefined ? { line: outcome.line } : {}) },
        };
      }
      return {
        ok: true,
        // The sandbox cannot tell `return null` from no return; both mean "nothing to read back".
        returned: outcome.value !== null,
        ...(outcome.value !== null ? { value: outcome.value } : {}),
        patches: outcome.patches,
        logs,
      } satisfies RunOutcome;
    },
  };

  const autonomy = createAutonomy({
    model: (input) => ({
      stream: (r) => {
        // The handle is returned at once; the model is resolved (one workspace read) inside it.
        const started = defaultModel().then((ws) =>
          w.llm.stream({
            model: resolveModel(input.node, turn.definition, ws),
            system: r.system,
            messages: r.messages,
            stop: r.stop,
            temperature: r.temperature,
            purpose: r.purpose,
            context: {
              workspaceId: turn.workspaceId,
              mode: turn.mode,
              botId: turn.botId,
              conversationId: turn.conversationId,
              turnId: turn.turnId,
            },
          }),
        );
        return {
          textStream: {
            async *[Symbol.asyncIterator]() {
              yield* (await started).textStream;
            },
          },
          result: started.then((h) => h.result),
        };
      },
    }),
    code: run,
    context,
  });
  return { step: (input) => autonomy.step(input as never) as never };
}

function manifestEntry(tool: Tool): BuilderTool {
  return tool.type === "table" ? { name: tool.name, operations: [...tool.operations] } : { name: tool.name };
}

function logText(arg: unknown): string {
  return typeof arg === "string" ? arg : JSON.stringify(arg);
}

/** The engine's code port as a tool runner: a code tool's exec has the node's scopes, read only. */
function toolCode(code: CodePort): ToolCodeRunner {
  return {
    run: async (request) => {
      const outcome = await code.run({ ...request, scopes: request.scopes as never });
      return outcome.ok
        ? { ok: true, value: outcome.value, patches: outcome.patches, said: outcome.said }
        : { ok: false, message: outcome.message };
    },
  };
}
