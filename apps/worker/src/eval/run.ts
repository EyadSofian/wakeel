import {
  AppError,
  type BotDefinition,
  ConversationState,
  type EvalResult,
  EvalRunId,
  type EvalTurnResult,
  type Json,
  Message,
  newRequestId,
  WorkspaceId,
} from "@wakeel/contracts";
import {
  botMessagesOfTurn,
  getConversation,
  getEndUser,
  getTurnSummary,
  getWorkspace,
  insertEvalInbound,
  listTurnSpans,
  outboxOfTurn,
  savedEvalTurn,
  saveEvalResult,
  saveEvalRunStatus,
  saveEvalTurn,
  startEvalRun,
  type Tx,
} from "@wakeel/db";
import { type AssertionPorts, assertTurn, type TurnEvidence } from "@wakeel/evals";
import type { LlmClient } from "@wakeel/llm";
import type { SandboxClient } from "@wakeel/sandbox-client";
import { z } from "zod";
import { drainConversation, type TurnDeps } from "../turn/drain";
import { modelId } from "../turn/handoff-summary";
import type { Processor } from "../workers";
import { judgeReplies, turnPassages } from "./judge";

const jobInput = z.object({ workspaceId: WorkspaceId, runId: EvalRunId });
type Receipt = { conversationId: string; turnId: string };
type Run = NonNullable<Awaited<ReturnType<typeof startEvalRun>>>;

export function evalProcessor(turns: TurnDeps, llm: LlmClient, sandbox: SandboxClient): Processor {
  return async (job, log) => {
    const { workspaceId, runId } = jobInput.parse(job.data);
    const tx = <T>(read: (table: Tx) => Promise<T>) => turns.db.withWorkspace(workspaceId, read);
    const run = await tx((table) => startEvalRun(table, runId));
    if (!run) return;
    const statuses: EvalResult["status"][] = [];
    for (const entry of run.cases) {
      const started = Date.now();
      const results: EvalTurnResult[] = [];
      let receipt: Receipt | undefined;
      let segment = 0;
      let errorCode: string | undefined;
      try {
        for (const [index, step] of entry.script.turns.entries()) {
          if (step.newConversation) segment++;
          const prior = await tx((table) => savedEvalTurn(table, runId, entry.id, index));
          if (prior) {
            results.push(prior);
            if (prior.conversationId && prior.turnId)
              receipt = { conversationId: prior.conversationId, turnId: prior.turnId };
            continue;
          }
          const begun = await tx((table) => insertEvalInbound(table, { runId, caseId: entry.id, index, segment }));
          receipt = begun;
          const drained = await drainConversation(turns, begun.conversationId);
          if (drained.stopped === "leased_elsewhere" || drained.stopped === "lease_lost") throw new LeaseBusy();
          const evidence = await tx((table) => turnEvidence(table, run.definition, begun));
          const assertions = await assertTurn(
            step,
            evidence,
            assertionPorts({ llm, sandbox, tx, run, workspaceId, receipt: begun }),
          );
          const item: EvalTurnResult = {
            index,
            ...begun,
            assertions,
            ...(step.expectSilence ? { silencePassed: evidence.messages.length === 0 } : {}),
          };
          await tx((table) => saveEvalTurn(table, runId, entry.id, item));
          results.push(item);
        }
      } catch (error) {
        if (error instanceof LeaseBusy) throw error;
        errorCode = error instanceof AppError ? error.code : "internal_error";
        log.warn({ code: errorCode, runId, caseId: entry.id }, "eval case failed to execute");
      }
      const failed = results.some(
        (result) => result.silencePassed === false || result.assertions.some((item) => !item.passed),
      );
      const status = errorCode ? "error" : failed ? "failed" : "passed";
      statuses.push(status);
      await tx((table) =>
        saveEvalResult(table, runId, entry.id, {
          status,
          turns: results,
          durationMs: Math.max(0, Date.now() - started),
          ...(receipt ? { conversationId: receipt.conversationId } : {}),
          ...(errorCode ? { errorCode } : {}),
        }),
      );
    }
    await tx((table) =>
      saveEvalRunStatus(
        table,
        runId,
        statuses.includes("error") ? "error" : statuses.includes("failed") ? "failed" : "passed",
      ),
    );
  };
}

class LeaseBusy extends Error {
  constructor() {
    super("The evaluation conversation is still being processed.");
  }
}

async function turnEvidence(tx: Tx, definition: BotDefinition, receipt: Receipt): Promise<TurnEvidence> {
  const { turnId, conversationId } = receipt;
  const turn = await getTurnSummary(tx, turnId);
  const spans = await listTurnSpans(tx, turnId);
  const duration = spans.find((span) => span.kind === "turn")?.durationMs;
  if (!turn || turn.conversationId !== conversationId || turn.status === "failed" || duration === undefined)
    throw new AppError("eval_turn_failed");
  const messages = (await botMessagesOfTurn(tx, turnId)).map((row) => {
    const payload = Message.shape.payload.parse(row.payload);
    return {
      type: payload.type,
      ...("text" in payload && typeof payload.text === "string" ? { text: payload.text } : {}),
      citationTitles: Message.shape.citations.parse(row.citations).map((citation) => citation.title),
    };
  });
  const conversation = await getConversation(tx, conversationId);
  const state = ConversationState.parse(conversation.state);
  const user = await getEndUser(tx, conversation.endUserId);
  const variables: Record<string, Json> = Object.create(null);
  for (const variable of definition.manifest.variables) {
    if (variable.sensitive) continue;
    const value =
      variable.scope === "user"
        ? user.vars[variable.id]
        : variable.scope === "conversation"
          ? state.conversationVars[variable.id]
          : variable.default;
    if (value !== undefined) variables[`${variable.scope}.${variable.name}`] = value;
  }
  for (const frame of state.stack) {
    const workflow = definition.workflows.find((item) => item.id === frame.workflowId);
    for (const variable of workflow?.variables ?? []) {
      const value = frame.vars[variable.id];
      if (!variable.sensitive && value !== undefined) variables[`workflow.${variable.name}`] = value;
    }
  }
  const events = await outboxOfTurn(tx, conversationId, turnId, { ephemeral: false });
  return {
    messages,
    variables,
    latencyMs: duration,
    calls: spans.flatMap((span) =>
      span.kind === "tool.call"
        ? [
            {
              name: span.attrs.name,
              ...(span.attrs.input?.inline && span.attrs.input.value !== "[redacted]"
                ? { input: span.attrs.input.value }
                : {}),
            },
          ]
        : [],
    ),
    nodeNames: spans.flatMap((span) => (span.kind === "node" ? [span.name] : [])),
    exits: spans.flatMap((span) => (span.kind === "autonomy.iteration" && span.attrs.exit ? [span.attrs.exit] : [])),
    handoffRequested: events.some((event) => event.type === "handoff.requested"),
    passages: turnPassages(state, turnId),
  };
}

function assertionPorts({
  llm,
  sandbox,
  tx,
  run,
  workspaceId,
  receipt,
}: {
  llm: LlmClient;
  sandbox: SandboxClient;
  tx: <T>(read: (table: Tx) => Promise<T>) => Promise<T>;
  run: Run;
  workspaceId: string;
  receipt: Receipt;
}): AssertionPorts {
  return {
    async matches({ pattern, flags, text }) {
      const result = await sandbox.exec(
        {
          execId: newRequestId(),
          kind: "code",
          source: "return new RegExp(turn.pattern, turn.flags).test(turn.text);",
          scopes: { turn: { pattern, flags, text } },
          limits: { timeoutMs: 250, memoryMb: 32 },
        },
        {
          onToolCall: async () => {
            throw new AppError("eval_assertion_unavailable");
          },
        },
      );
      if (result.t !== "result" || typeof result.value !== "boolean") throw new AppError("eval_assertion_unavailable");
      return result.value;
    },
    async judge({ rubric, replies, passages }) {
      const ref = run.definition.manifest.settings.models.utility ?? (await tx(getWorkspace)).settings.utilityModel;
      if (!ref) throw new AppError("model_not_configured");
      return judgeReplies(llm, {
        model: modelId(ref),
        rubric,
        replies,
        ...(passages ? { passages } : {}),
        context: { workspaceId, mode: "eval", botId: run.botId, ...receipt },
      });
    },
  };
}
