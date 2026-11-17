import {
  AppError,
  type AutonomousNode,
  type AutonomyMemory,
  type BotDefinition,
  type BotMessagePayload,
  type Json,
  type SearchCitations,
  type Variable,
} from "@wakeel/contracts";
import {
  type AutonomyKnowledge,
  type AutoSearchTrace,
  runAutoSearch,
  searchableMessage,
} from "./knowledge/auto-search";
import { buildPrompt } from "./prompt/build";
import type { TranscriptMessage } from "./prompt/transcript";
import { afterRun, feedbackFor } from "./protocol/outcome";
import { contextFromNode, protocolV1 } from "./protocol/protocol-v1";
import type { AutonomyProtocol, FinishReason, ResolvedExit } from "./protocol/types";
import { mapCitations } from "./tools/citations";
import { resumedFeedback, type ToolResolution } from "./tools/feedback";
import type { PendingToolCall } from "./tools/suspension";

/**
 * The Autonomous Node's iteration (architecture §6.3, task 6.5). The engine calls `step` once per
 * iteration, each in its own step transaction; `next` asks for another. One call: build the prompt,
 * stream the model's reply through the protocol, run the code block if there is one, check every
 * variable write against the node's access list and the variable's type, and resolve the exit.
 * Anything wrong is fed back to the model on the next iteration; nothing invalid is applied.
 *
 * This package depends only on contracts (CLAUDE.md §4), so the ports below mirror the engine's
 * `AutonomyPort` structurally; the worker passes this object to the engine as is.
 */

export type ScopeName = "bot" | "user" | "conversation" | "workflow" | "event" | "env" | "turn";
export type Scopes = { readonly [K in ScopeName]?: Json };

export interface AutonomyStepInput {
  retrievalCitations?: SearchCitations;
  node: AutonomousNode;
  location: { workflowId: string; nodeId: string };
  memory: AutonomyMemory | undefined;
  resume?: { kind: "message"; event: Json } | { kind: "tool_result"; toolCallId: string; event: Json };
  scopes: Scopes;
  turnId: string;
  stepSeq: number;
  idempotencyKey: string;
  deadline: number;
}

export interface VariableWrite {
  scope: "user" | "conversation" | "workflow";
  variableId: string;
  value: Json;
}

export type AutonomyOutcome =
  | { type: "next" }
  | { type: "goto"; port: string }
  | { type: "wait"; wait: { kind: "listen"; nodeId: string; since: string } }
  | {
      type: "wait";
      wait: { kind: "tool"; nodeId: string; toolId: string; toolCallId: string; reason?: string; since: string };
    }
  | {
      type: "call";
      workflowId: string;
      inputs: Record<string, Json>;
      outputs: Record<string, string>;
      toolCallId: string;
    }
  | { type: "handoff"; reason: string; summary: string; variables: Record<string, Json> };

export interface AutonomyStepResult {
  retrievalCitations?: SearchCitations;
  outcome: AutonomyOutcome;
  messages?: BotMessagePayload[];
  writes?: VariableWrite[];
  logs?: { level: "debug" | "info" | "warn" | "error"; message: string; data?: Json }[];
  turn?: Record<string, Json>;
  /** The exit's name and data, shown downstream as `event.exit`. */
  exit?: { name: string; data: Json };
  memory: AutonomyMemory;
  /** What happened in this iteration, for the trace (task 6.9). */
  iteration?: IterationTrace;
}

/** One tool call from the run block, as the worker saw it (architecture §6.5 "records a span"). */
export interface ToolCallTrace {
  name: string;
  toolId?: string;
  toolType: "code" | "kb_search" | "table" | "workflow";
  sideEffects: boolean;
  input: Json;
  output?: Json;
  /** The error the model's code received, or that the call suspended the block. */
  error?: string;
  startedAt: string;
  durationMs: number;
}

/** The model call of one iteration. `prompt` is what was sent; usage is the provider's count. */
export interface LlmCallTrace {
  model: string;
  provider?: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  costMicroUsd?: number;
  ttftMs?: number;
  finishReason: string;
  prompt: Json;
  startedAt: string;
  durationMs: number;
}

/** One iteration for the trace (04-contracts/trace.ts `autonomy.iteration`, task 6.9). */
export interface IterationTrace {
  index: number;
  status: "exit" | "run_result" | "run_error" | "protocol_error" | "exit_invalid" | "suspended" | "recovered";
  exit?: string;
  /** The model's raw reply. */
  response: string;
  /** The `:::run` body. */
  code?: string;
  /** The run block's value, the error fed back, or the call that suspended it. */
  result?: Json;
  llm: LlmCallTrace;
  tools: ToolCallTrace[];
  /** The automatic search that ran before this iteration (ADR-055). */
  autoSearch?: AutoSearchTrace;
}

/** The model, already resolved for this node and workspace by the worker (llm client `stream`). */
export interface AutonomyModel {
  stream(request: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    stop: string[];
    temperature: number;
    purpose: "autonomy";
  }): {
    textStream: AsyncIterable<string>;
    result: Promise<{
      text: string;
      finishReason: string;
      /** The model that answered (a fallback, perhaps) and what it cost, for the trace. */
      model?: string;
      provider?: string;
      usage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number };
      costMicroUsd?: number;
      ttftMs?: number;
    }>;
  };
}

export type RunOutcome =
  | {
      ok: true;
      retrievalCitations?: SearchCitations;
      /** The block ran `return`. */
      returned: boolean;
      value?: Json;
      /** Writes by scope (`conversation`, `user`, `workflow`, `turn`, `memo`), by top-level name. */
      patches: Record<string, { set?: Record<string, Json>; unset?: string[] }>;
      logs?: { level: "debug" | "info" | "warn" | "error"; message: string }[];
      tools?: ToolCallTrace[];
    }
  | {
      ok: false;
      retrievalCitations?: SearchCitations;
      error: { message: string; line?: number };
      tools?: ToolCallTrace[];
    }
  /** A tool call ended the block at the call site (ADR-035): nothing after it ran, no patch exists. */
  | {
      ok: false;
      retrievalCitations?: SearchCitations;
      suspended: PendingToolCall & { reason?: string };
      logs?: { level: "debug" | "info" | "warn" | "error"; message: string }[];
      tools?: ToolCallTrace[];
    };

/**
 * Runs the model's `:::run` block in the sandbox with the node's tools bridged (task 6.6, ADR-032).
 * `scopes` includes `memo`; the run's `memo` patch comes back like any other scope's.
 */
export interface AutonomyCode {
  run(request: {
    node: AutonomousNode;
    retrievalCitations?: SearchCitations;
    source: string;
    scopes: Record<string, Json>;
    idempotencyKey: string;
    deadline: number;
  }): Promise<RunOutcome>;
}

/** What the worker loads for each iteration. */
export interface AutonomyContext {
  definition: BotDefinition;
  bot: Record<string, Json>;
  env: Record<string, Json>;
  transcript: readonly TranscriptMessage[];
  summary?: string;
  now: string;
}

export interface AutonomyDeps {
  model(input: AutonomyStepInput): AutonomyModel;
  code: AutonomyCode;
  context(input: AutonomyStepInput): Promise<AutonomyContext>;
  protocol?: AutonomyProtocol;
  /** The turn's knowledge search and the utility model, for `autoSearch` (ADR-055). */
  knowledge?: AutonomyKnowledge;
  /** Milliseconds since the epoch, for the trace's timings. Tests pass a fake clock. */
  now?(): number;
}

/** Feedback text is trimmed to this many characters: enough to act on, cheap to send again. */
export const FEEDBACK_MAX_CHARS = 4_000;
/**
 * The budget for a run block's returned value (architecture §6.3 "truncated to budget"). It is larger
 * than other feedback because it carries knowledge passages: five full-size Arabic chunks are about
 * 6,500 characters, and a cut at 4,000 sent the model three of them and half of a fourth.
 */
export const RUN_RESULT_MAX_CHARS = 12_000;
/** `memo` stays small: it is resent on every iteration. */
export const MEMO_MAX_BYTES = 16 * 1024;

export function createAutonomy(deps: AutonomyDeps): { step(input: AutonomyStepInput): Promise<AutonomyStepResult> } {
  const protocol = deps.protocol ?? protocolV1;
  const now = deps.now ?? Date.now;
  return {
    async step(input) {
      const { node } = input;
      const memory: AutonomyMemory = structuredClone(
        input.memory ?? { iteration: 0, memo: {}, feedback: [] },
      ) as AutonomyMemory;
      // A user's reply after `listen`, or a submitted tool result, starts the node's next turn with a
      // fresh iteration budget (ADR-035 §5).
      if (input.resume?.kind === "message") memory.iteration = 0;
      resumeTool(memory, input.resume);
      if (memory.iteration >= node.maxIterations)
        throw new AppError("autonomy_loop_exceeded", { node: node.name, limit: node.maxIterations });
      memory.iteration += 1;

      const ctx = await deps.context(input);
      const access = accessible(node, ctx.definition, input.location.workflowId);

      // ADR-055: a user message that starts the node's turn (a reply after listen, or the message
      // that entered the node) is searched once, before the first iteration. Later iterations of the
      // turn reuse the result from memory; tool results and triggers never search.
      let retrievalCitations = input.retrievalCitations;
      const searchWarnings: string[] = [];
      let autoSearch: AutoSearchTrace | undefined;
      const startsTurn = input.resume?.kind === "message" || (input.memory === undefined && input.resume === undefined);
      const asked =
        startsTurn && node.autoSearch
          ? searchableMessage(input.resume?.kind === "message" ? input.resume.event : input.scopes.event)
          : undefined;
      if (asked !== undefined) {
        const found = await runAutoSearch(
          {
            node,
            message: asked,
            transcript: ctx.transcript,
            ...(ctx.summary ? { summary: ctx.summary } : {}),
            turnId: input.turnId,
            ...(retrievalCitations ? { citations: retrievalCitations } : {}),
            maxChars: RUN_RESULT_MAX_CHARS,
          },
          deps.knowledge,
        );
        memory.knowledge = found.knowledge;
        retrievalCitations = found.citations ?? retrievalCitations;
        autoSearch = found.trace;
        searchWarnings.push(...found.warnings);
      }
      const knowledge = memory.knowledge?.turnId === input.turnId ? memory.knowledge : undefined;
      const prompt = buildPrompt({
        node,
        definition: ctx.definition,
        bot: ctx.bot,
        env: ctx.env,
        variables: [
          ...access.map((a) => ({
            path: `${a.scope}.${a.variable.name}`,
            mode: a.mode,
            value: currentValue(input.scopes, a),
          })),
          { path: "memo", mode: "write" as const, value: memory.memo as Json },
        ],
        transcript: ctx.transcript,
        ...(ctx.summary ? { summary: ctx.summary } : {}),
        feedback: memory.feedback,
        iteration: memory.iteration,
        now: ctx.now,
        ...(knowledge ? { knowledge } : {}),
      });
      memory.feedback = [];

      const llmStarted = now();
      const handle = deps.model(input).stream({
        system: prompt.system,
        messages: prompt.messages,
        stop: [...protocol.stopSequences],
        temperature: node.temperature,
        purpose: "autonomy",
      });
      const reader = protocol.createReader(contextFromNode(node));
      let response = "";
      for await (const chunk of handle.textStream) {
        response += chunk;
        reader.push(chunk);
      }
      const answered = await handle.result;
      const { finishReason } = answered;
      const { result } = reader.end(asFinishReason(finishReason));
      const trace: IterationTrace = {
        index: memory.iteration,
        status: result.recovered ? "recovered" : "run_result",
        response,
        llm: {
          model: answered.model ?? node.model ?? "",
          ...(answered.provider ? { provider: answered.provider } : {}),
          ...(answered.usage
            ? {
                usage: {
                  inputTokens: answered.usage.inputTokens,
                  cachedInputTokens: answered.usage.cachedInputTokens ?? 0,
                  outputTokens: answered.usage.outputTokens,
                },
              }
            : {}),
          ...(answered.costMicroUsd !== undefined ? { costMicroUsd: answered.costMicroUsd } : {}),
          ...(answered.ttftMs !== undefined ? { ttftMs: answered.ttftMs } : {}),
          finishReason,
          prompt: {
            system: prompt.system,
            messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
          },
          startedAt: new Date(llmStarted).toISOString(),
          durationMs: Math.max(0, now() - llmStarted),
        },
        tools: [],
        ...(autoSearch ? { autoSearch } : {}),
      };
      // Citation tokens never reach the user (§6.5); only tokens registered this turn map to sources.
      // A text that was nothing but tokens is dropped rather than sent empty.
      const messages = result.messages
        .map((m) =>
          m.type === "text"
            ? {
                ...m,
                text: m.text.replace(/\s*\[\[(c\d+)\]\]/g, (marker, token: string) =>
                  retrievalCitations?.sources[token] ? marker : "",
                ),
              }
            : m,
        )
        .filter((m) => m.type !== "text" || mapCitations(m.text, retrievalCitations?.sources ?? {}).text.trim() !== "");
      const logs: NonNullable<AutonomyStepResult["logs"]> = [];
      if (result.recovered) logs.push({ level: "warn", message: "protocol_recovered: the reply had no directives" });
      for (const message of searchWarnings) logs.push({ level: "warn", message });

      const iterate = (extra: Partial<AutonomyStepResult> = {}): AutonomyStepResult => ({
        outcome: { type: "next" },
        ...(messages.length > 0 ? { messages } : {}),
        ...(logs.length > 0 ? { logs } : {}),
        ...extra,
        memory,
        ...(retrievalCitations ? { retrievalCitations } : {}),
        iteration: trace,
      });

      const issue = feedbackFor(result);
      if (issue) {
        memory.feedback.push(issue);
        trace.status = issue.kind === "exit_invalid" ? "exit_invalid" : "protocol_error";
        trace.result = issue.text;
        return iterate();
      }

      let writes: VariableWrite[] = [];
      let turn: Record<string, Json> | undefined;
      if (result.run) {
        trace.code = result.run.code;
        const run = await deps.code.run({
          node,
          ...(retrievalCitations ? { retrievalCitations } : {}),
          source: result.run.code,
          scopes: { ...(input.scopes as Record<string, Json>), memo: memory.memo as Json },
          idempotencyKey: `${input.idempotencyKey}:run`,
          deadline: input.deadline,
        });
        retrievalCitations = run.retrievalCitations ?? retrievalCitations;
        trace.tools = run.tools ?? [];
        if (!run.ok && "suspended" in run) {
          for (const l of run.logs ?? []) logs.push(l);
          trace.status = "suspended";
          trace.result = { tool: run.suspended.name, toolCallId: run.suspended.toolCallId };
          return suspend(run.suspended);
        }
        if (!run.ok) {
          trace.status = "run_error";
          trace.result = { message: run.error.message, ...(run.error.line ? { line: run.error.line } : {}) };
          memory.feedback.push({
            kind: "run_error",
            text: `Your code failed${run.error.line ? ` on line ${run.error.line}` : ""}: ${run.error.message}. Nothing it changed was kept.`,
          });
          return iterate();
        }
        for (const l of run.logs ?? []) logs.push(l);
        const applied = applyPatches(run.patches, access, memory, input.scopes);
        writes = applied.writes;
        turn = applied.turn;
        if (applied.rejected.length > 0)
          memory.feedback.push({ kind: "write_rejected", text: applied.rejected.join("\n") });
        const next = afterRun(result, { returned: run.returned });
        if (run.returned) trace.result = run.value ?? null;
        if (next.action === "iterate") {
          if (run.returned) memory.feedback.push({ kind: "run_result", text: fitResult(run.value ?? null) });
          return iterate({ ...(writes.length > 0 ? { writes } : {}), ...(turn ? { turn } : {}) });
        }
        return leave(next.exit);
      }
      if (result.exit) return leave(result.exit);
      // A reply with messages and neither code nor an exit: the protocol accepted it, so iterate.
      return iterate();

      /** The call is kept pending until its result arrives (§6.3); the budget carries on. */
      function suspend(pending: PendingToolCall & { reason?: string }): AutonomyStepResult {
        memory.pendingTool = {
          toolId: pending.toolId,
          toolCallId: pending.toolCallId,
          name: pending.name,
          input: pending.input,
        };
        logs.push({ level: "info", message: `${pending.name} ended the run block; waiting for its result` });
        const outcome: AutonomyOutcome = pending.workflowId
          ? {
              type: "call",
              workflowId: pending.workflowId,
              inputs: (pending.input ?? {}) as Record<string, Json>,
              outputs: {},
              toolCallId: pending.toolCallId,
            }
          : {
              type: "wait",
              wait: {
                kind: "tool",
                nodeId: node.id,
                toolId: pending.toolId,
                toolCallId: pending.toolCallId,
                ...(pending.reason ? { reason: pending.reason } : {}),
                since: ctx.now,
              },
            };
        return {
          outcome,
          ...(messages.length > 0 ? { messages } : {}),
          ...(logs.length > 0 ? { logs } : {}),
          memory,
          ...(retrievalCitations ? { retrievalCitations } : {}),
          iteration: trace,
        };
      }

      function leave(exit: ResolvedExit): AutonomyStepResult {
        // Leaving the node ends its turn: the next visit starts with a fresh budget.
        memory.iteration = 0;
        if (trace.status !== "recovered") trace.status = "exit";
        trace.exit = exit.kind === "exit" ? exit.name : exit.kind;
        const shared = {
          ...(messages.length > 0 ? { messages } : {}),
          ...(writes.length > 0 ? { writes } : {}),
          ...(turn ? { turn } : {}),
          ...(logs.length > 0 ? { logs } : {}),
          memory,
          ...(retrievalCitations ? { retrievalCitations } : {}),
          iteration: trace,
        };
        switch (exit.kind) {
          case "listen":
            return { ...shared, outcome: { type: "wait", wait: { kind: "listen", nodeId: node.id, since: ctx.now } } };
          case "handoff":
            return {
              ...shared,
              outcome: { type: "handoff", reason: exit.reason ?? "", summary: exit.summary ?? "", variables: {} },
            };
          case "exit":
            return {
              ...shared,
              outcome: { type: "goto", port: `exit:${exit.exitId}` },
              exit: { name: exit.name, data: exit.data },
            };
        }
      }
    },
  };
}

/**
 * Turns a finished suspended call into feedback (§6.3, ADR-035 §4): the outputs the engine recorded
 * when the called workflow returned, or a result submitted for the pending call. A result for any
 * other call is ignored.
 */
function resumeTool(memory: AutonomyMemory, resume: AutonomyStepInput["resume"]): void {
  const pending = memory.pendingTool;
  if (!pending) return;
  if (resume?.kind === "tool_result") {
    if (resume.toolCallId !== pending.toolCallId) return;
    const payload = field(resume.event, "payload");
    const error = field(payload, "error");
    const resolution: ToolResolution =
      error !== undefined
        ? { error: String(field(error, "message") ?? "the tool reported an error") }
        : { result: field(payload, "result") ?? null };
    memory.feedback.push({ kind: "tool_resumed", text: resumedFeedback(pending, resolution) });
    memory.iteration = 0;
    delete memory.pendingTool;
    return;
  }
  for (const item of memory.feedback) {
    if (item.kind !== "tool_resumed") continue;
    let recorded: unknown;
    try {
      recorded = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (field(recorded as Json, "toolCallId") !== pending.toolCallId) continue;
    const outputs = (field(recorded as Json, "outputs") ?? {}) as Record<string, Json>;
    item.text = resumedFeedback(pending, { outputs });
    delete memory.pendingTool;
  }
}

function field(value: Json | undefined, key: string): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>)[key] : undefined;
}

interface Access {
  variable: Variable;
  scope: "user" | "conversation" | "workflow";
  mode: "read" | "write";
}

/** The variables the node lists, resolved to their declarations (manifest or the current workflow). */
function accessible(node: AutonomousNode, definition: BotDefinition, workflowId: string): Access[] {
  const workflowVars = definition.workflows.find((w) => w.id === workflowId)?.variables ?? [];
  return node.variableAccess.flatMap((a) => {
    const global = definition.manifest.variables.find((v) => v.id === a.variableId);
    if (global && global.scope !== "bot") return [{ variable: global, scope: global.scope, mode: a.mode }];
    const local = workflowVars.find((v) => v.id === a.variableId);
    return local ? [{ variable: local, scope: "workflow" as const, mode: a.mode }] : [];
  });
}

function currentValue(scopes: Scopes, a: Access): Json | undefined {
  const scope = scopes[a.scope];
  return scope && typeof scope === "object" && !Array.isArray(scope)
    ? (scope as Record<string, Json>)[a.variable.name]
    : undefined;
}

/**
 * Checks the run block's writes (architecture §6.3): a variable must be listed with `write` access
 * and the value must fit its type. Accepted ones become writes; the rest are explained to the model.
 * `turn` and `memo` are the node's own scratch space.
 */
function applyPatches(
  patches: Record<string, { set?: Record<string, Json>; unset?: string[] }>,
  access: Access[],
  memory: AutonomyMemory,
  scopes: Scopes,
): { writes: VariableWrite[]; turn?: Record<string, Json>; rejected: string[] } {
  const writes: VariableWrite[] = [];
  const rejected: string[] = [];
  let turn: Record<string, Json> | undefined;
  for (const [scope, patch] of Object.entries(patches)) {
    if (scope === "memo") {
      const memo = { ...(memory.memo as Record<string, Json>), ...(patch.set ?? {}) };
      for (const k of patch.unset ?? []) delete memo[k];
      if (new TextEncoder().encode(JSON.stringify(memo)).length > MEMO_MAX_BYTES)
        rejected.push(`memo was not changed: it would be over ${MEMO_MAX_BYTES / 1024} KB.`);
      else memory.memo = memo;
      continue;
    }
    if (scope === "turn") {
      const current = (scopes.turn ?? {}) as Record<string, Json>;
      turn = { ...current, ...(patch.set ?? {}) };
      for (const k of patch.unset ?? []) delete turn[k];
      continue;
    }
    const entries: [string, Json][] = [
      ...Object.entries(patch.set ?? {}),
      ...(patch.unset ?? []).map((k): [string, Json] => [k, null]),
    ];
    for (const [name, value] of entries) {
      const path = `${scope}.${name}`;
      const a = access.find((x) => x.scope === scope && x.variable.name === name);
      if (!a) {
        rejected.push(`${path} was not changed: this node has no access to it.`);
        continue;
      }
      if (a.mode !== "write") {
        rejected.push(`${path} was not changed: it is read only here.`);
        continue;
      }
      if (value !== null && !fits(value, a.variable)) {
        rejected.push(`${path} was not changed: it must be ${describeType(a.variable)}, not ${describeValue(value)}.`);
        continue;
      }
      writes.push({ scope: a.scope, variableId: a.variable.id, value });
    }
  }
  return { writes, ...(turn ? { turn } : {}), rejected };
}

function fits(value: Json, v: Variable): boolean {
  switch (v.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "enum":
      return typeof value === "string" && (v.enumValues ?? []).includes(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "any":
      return true;
  }
}

function describeType(v: Variable): string {
  return v.type === "enum" ? `one of ${(v.enumValues ?? []).map((e) => JSON.stringify(e)).join(", ")}` : `a ${v.type}`;
}

function describeValue(value: Json): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : `${typeof value} ${trim(JSON.stringify(value), 60)}`;
}

const trim = (text: string, max = FEEDBACK_MAX_CHARS) => (text.length > max ? `${text.slice(0, max)}… (cut)` : text);

/**
 * A returned value as feedback, within RUN_RESULT_MAX_CHARS. A list over the budget keeps its leading
 * items whole (search results come best first) and says how many it left out, so the model never
 * reads half a passage as if it were the whole one. Anything else over the budget is cut.
 */
export function fitResult(value: Json, max = RUN_RESULT_MAX_CHARS): string {
  const json = JSON.stringify(value);
  if (json.length <= max || !Array.isArray(value)) return trim(json, max);
  const kept: Json[] = [];
  let size = 2;
  for (const item of value) {
    const cost = JSON.stringify(item).length + (kept.length > 0 ? 1 : 0);
    if (size + cost > max) break;
    kept.push(item);
    size += cost;
  }
  return `${JSON.stringify(kept)}\n${value.length - kept.length} of ${value.length} items were left out: the result is over the size limit. Return fewer or shorter items to see them.`;
}

function asFinishReason(reason: string): FinishReason {
  return reason === "length" || reason === "error" ? reason : "stop";
}
