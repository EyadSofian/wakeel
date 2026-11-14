import {
  AppError,
  type AutonomousNode,
  type AutonomyMemory,
  type BotDefinition,
  type BotMessagePayload,
  type Json,
  type Variable,
} from "@wakeel/contracts";
import { buildPrompt } from "./prompt/build";
import type { TranscriptMessage } from "./prompt/transcript";
import { afterRun, feedbackFor } from "./protocol/outcome";
import { contextFromNode, protocolV1 } from "./protocol/protocol-v1";
import type { AutonomyProtocol, FinishReason, ResolvedExit } from "./protocol/types";

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
  | { type: "handoff"; reason: string; summary: string; variables: Record<string, Json> };

export interface AutonomyStepResult {
  outcome: AutonomyOutcome;
  messages?: BotMessagePayload[];
  writes?: VariableWrite[];
  logs?: { level: "debug" | "info" | "warn" | "error"; message: string; data?: Json }[];
  turn?: Record<string, Json>;
  /** The exit's name and data, shown downstream as `event.exit`. */
  exit?: { name: string; data: Json };
  memory: AutonomyMemory;
}

/** The model, already resolved for this node and workspace by the worker (llm client `stream`). */
export interface AutonomyModel {
  stream(request: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    stop: string[];
    temperature: number;
    purpose: "autonomy";
  }): { textStream: AsyncIterable<string>; result: Promise<{ text: string; finishReason: string }> };
}

export type RunOutcome =
  | {
      ok: true;
      /** The block ran `return`. */
      returned: boolean;
      value?: Json;
      /** Writes by scope (`conversation`, `user`, `workflow`, `turn`, `memo`), by top-level name. */
      patches: Record<string, { set?: Record<string, Json>; unset?: string[] }>;
      logs?: { level: "debug" | "info" | "warn" | "error"; message: string }[];
    }
  | { ok: false; error: { message: string; line?: number } };

/** Runs the model's `:::run` block in the sandbox (tools are bridged by task 6.6). */
export interface AutonomyCode {
  run(request: {
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
}

/** Feedback text is trimmed to this many characters: enough to act on, cheap to send again. */
export const FEEDBACK_MAX_CHARS = 4_000;
/** `memo` stays small: it is resent on every iteration. */
export const MEMO_MAX_BYTES = 16 * 1024;

export function createAutonomy(deps: AutonomyDeps): { step(input: AutonomyStepInput): Promise<AutonomyStepResult> } {
  const protocol = deps.protocol ?? protocolV1;
  return {
    async step(input) {
      const { node } = input;
      const memory: AutonomyMemory = structuredClone(
        input.memory ?? { iteration: 0, memo: {}, feedback: [] },
      ) as AutonomyMemory;
      // A user's reply after `listen` starts the node's next turn with a fresh iteration budget.
      if (input.resume?.kind === "message") memory.iteration = 0;
      if (memory.iteration >= node.maxIterations)
        throw new AppError("autonomy_loop_exceeded", { node: node.name, limit: node.maxIterations });
      memory.iteration += 1;

      const ctx = await deps.context(input);
      const access = accessible(node, ctx.definition, input.location.workflowId);
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
      });
      memory.feedback = [];

      const handle = deps.model(input).stream({
        system: prompt.system,
        messages: prompt.messages,
        stop: [...protocol.stopSequences],
        temperature: node.temperature,
        purpose: "autonomy",
      });
      const reader = protocol.createReader(contextFromNode(node));
      for await (const chunk of handle.textStream) reader.push(chunk);
      const { finishReason } = await handle.result;
      const { result } = reader.end(asFinishReason(finishReason));
      const messages = result.messages;
      const logs: NonNullable<AutonomyStepResult["logs"]> = [];
      if (result.recovered) logs.push({ level: "warn", message: "protocol_recovered: the reply had no directives" });

      const iterate = (extra: Partial<AutonomyStepResult> = {}): AutonomyStepResult => ({
        outcome: { type: "next" },
        ...(messages.length > 0 ? { messages } : {}),
        ...(logs.length > 0 ? { logs } : {}),
        ...extra,
        memory,
      });

      const issue = feedbackFor(result);
      if (issue) {
        memory.feedback.push(issue);
        return iterate();
      }

      let writes: VariableWrite[] = [];
      let turn: Record<string, Json> | undefined;
      if (result.run) {
        const run = await deps.code.run({
          source: result.run.code,
          scopes: { ...(input.scopes as Record<string, Json>), memo: memory.memo as Json },
          idempotencyKey: `${input.idempotencyKey}:run`,
          deadline: input.deadline,
        });
        if (!run.ok) {
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
        if (next.action === "iterate") {
          if (run.returned) memory.feedback.push({ kind: "run_result", text: trim(JSON.stringify(run.value ?? null)) });
          return iterate({ ...(writes.length > 0 ? { writes } : {}), ...(turn ? { turn } : {}) });
        }
        return leave(next.exit);
      }
      if (result.exit) return leave(result.exit);
      // A reply with messages and neither code nor an exit: the protocol accepted it, so iterate.
      return iterate();

      function leave(exit: ResolvedExit): AutonomyStepResult {
        // Leaving the node ends its turn: the next visit starts with a fresh budget.
        memory.iteration = 0;
        const shared = {
          ...(messages.length > 0 ? { messages } : {}),
          ...(writes.length > 0 ? { writes } : {}),
          ...(turn ? { turn } : {}),
          ...(logs.length > 0 ? { logs } : {}),
          memory,
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

function asFinishReason(reason: string): FinishReason {
  return reason === "length" || reason === "error" ? reason : "stop";
}
