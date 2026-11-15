import {
  AppError,
  BotDefinition,
  EvalCase,
  EvalCaseEntry,
  EvalResult,
  EvalRun,
  EvalRunDetail,
  EvalSuite,
  EvalTarget,
  EvalTurnReceipt,
  EvalTurnResult,
  emptyState,
  type Json,
  newId,
  SendEventRequest,
  SendMessageRequest,
} from "@wakeel/contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../client";
import { getBot } from "./bots";
import {
  ensureConversation,
  findInboundByIdempotencyKey,
  insertInbound,
  insertUserMessage,
  upsertEndUser,
} from "./bridge";
import { currentWorkspace } from "./scope";
import { assembleDraft, getVersion } from "./versions";

const cases = z.array(EvalCaseEntry).max(100);
const runFields = sql`id, suite_id as "suiteId", status, target, to_char(created_at at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`;

export async function createEvalSuite(tx: Tx, botId: string, name: string) {
  await getBot(tx, botId);
  const result = await tx.execute(sql`insert into eval_suites (id, workspace_id, bot_id, name)
    values (${newId("es")}, ${currentWorkspace}, ${botId}, ${name}) returning id, name, revision`);
  return EvalSuite.parse(result.rows[0]);
}

export async function listEvalSuites(tx: Tx, botId: string, cursor: string | undefined, limit: number) {
  await getBot(tx, botId);
  const result = await tx.execute(sql`select id, name, revision from eval_suites where bot_id=${botId}
    and id > ${cursor ?? ""} order by id limit ${limit + 1}`);
  const data = z.array(EvalSuite).parse(result.rows.slice(0, limit));
  return { data, nextCursor: result.rows.length > limit ? (data.at(-1)?.id ?? null) : null };
}

async function needSuite(tx: Tx, botId: string, suiteId: string, lock = false) {
  const row = (
    await tx.execute(sql`select id, name, revision from eval_suites where
    bot_id=${botId} and id=${suiteId} ${lock ? sql`for update` : sql``}`)
  ).rows[0];
  if (!row) throw new AppError("not_found");
  return EvalSuite.parse(row);
}

export async function getEvalSuite(tx: Tx, botId: string, suiteId: string) {
  const suite = await needSuite(tx, botId, suiteId);
  return { ...suite, cases: await readCases(tx, suiteId) };
}

async function readCases(tx: Tx, suiteId: string) {
  return cases.parse(
    (
      await tx.execute(sql`select id, script, revision from eval_cases where
    suite_id=${suiteId} order by id limit 101`)
    ).rows,
  );
}

export async function saveEvalCase(
  tx: Tx,
  botId: string,
  suiteId: string,
  input: EvalCase,
  revision?: { id: string; expected: number },
) {
  await needSuite(tx, botId, suiteId, true);
  const script = JSON.stringify(EvalCase.parse(input));
  if (Buffer.byteLength(script) > 64 * 1024) throw new AppError("payload_too_large", { limit: "64 KB" });
  if (revision) {
    const updated = (
      await tx.execute(sql`update eval_cases set script=${script}::jsonb, revision=revision + 1
      where suite_id=${suiteId} and id=${revision.id} and revision=${revision.expected}
      returning id, script, revision`)
    ).rows[0];
    if (updated) return EvalCaseEntry.parse(updated);
    const current = (
      await tx.execute(sql`select id, script, revision from eval_cases where suite_id=${suiteId} and id=${revision.id}`)
    ).rows[0];
    if (!current) throw new AppError("not_found");
    const entry = EvalCaseEntry.parse(current);
    throw new AppError("revision_conflict", {}, { current: { rev: entry.revision, doc: entry.script } });
  }
  if ((await readCases(tx, suiteId)).length >= 100) {
    throw new AppError("validation_failed", {}, { detail: "A suite can contain up to 100 cases." });
  }
  return EvalCaseEntry.parse(
    (
      await tx.execute(sql`insert into eval_cases (id, workspace_id, bot_id, suite_id, script)
    values (${newId("ec")}, ${currentWorkspace}, ${botId}, ${suiteId}, ${script}::jsonb) returning id, script, revision`)
    ).rows[0],
  );
}

export async function createEvalRun(tx: Tx, botId: string, suiteId: string, target: EvalTarget) {
  await needSuite(tx, botId, suiteId, true);
  const snapshots = await readCases(tx, suiteId);
  if (!snapshots.length)
    throw new AppError("validation_failed", {}, { detail: "Add a case before running the suite." });
  const definition =
    target.kind === "draft"
      ? await assembleDraft(tx, botId)
      : (await getVersion(tx, botId, target.versionId)).definition;
  const connection = newId("conn");
  await tx.execute(sql`insert into bridge_connections (id, workspace_id, bot_id, name, target, eval_internal)
    values (${connection}, ${currentWorkspace}, ${botId}, 'Evaluation', 'draft', true)`);
  const row = (
    await tx.execute(sql`insert into eval_runs
      (id, workspace_id, bot_id, suite_id, connection_id, target, definition, cases)
    values (${newId("er")}, ${currentWorkspace}, ${botId}, ${suiteId}, ${connection},
      ${JSON.stringify(target)}::jsonb, ${JSON.stringify(definition)}::jsonb, ${JSON.stringify(snapshots)}::jsonb)
    returning ${runFields}`)
  ).rows[0];
  return EvalRun.parse(row);
}

export async function getEvalRun(tx: Tx, botId: string, runId: string) {
  const row = (await tx.execute(sql`select ${runFields}, cases from eval_runs where bot_id=${botId} and id=${runId}`))
    .rows[0];
  if (!row) throw new AppError("not_found");
  const results = (
    await tx.execute(sql`select case_id as "caseId", detail as result from eval_results
    where run_id=${runId} order by case_id`)
  ).rows;
  return EvalRunDetail.parse({ ...row, results });
}

export async function listEvalRuns(tx: Tx, botId: string, suiteId: string, cursor: string | undefined, limit: number) {
  await needSuite(tx, botId, suiteId);
  const result = await tx.execute(sql`select ${runFields} from eval_runs where suite_id=${suiteId}
    ${cursor ? sql`and id < ${cursor}` : sql``} order by id desc limit ${limit + 1}`);
  const data = z.array(EvalRun).parse(result.rows.slice(0, limit));
  return { data, nextCursor: result.rows.length > limit ? (data.at(-1)?.id ?? null) : null };
}

export async function startEvalRun(tx: Tx, runId: string) {
  const row = (
    await tx.execute(sql`update eval_runs set status='running' where id=${runId}
    and status in ('queued','running') returning id, bot_id as "botId", connection_id as "connectionId", target, definition, cases`)
  ).rows[0];
  return row
    ? z
        .object({
          id: EvalRun.shape.id,
          botId: z.string(),
          connectionId: z.string(),
          target: EvalTarget,
          definition: BotDefinition,
          cases,
        })
        .parse(row)
    : undefined;
}

export async function loadEvalDefinition(tx: Tx, botId: string, connectionId: string) {
  const row = (
    await tx.execute(sql`select definition from eval_runs where bot_id=${botId}
    and connection_id=${connectionId}`)
  ).rows[0];
  if (!row) throw new AppError("not_found");
  return BotDefinition.parse(row["definition"]);
}

export async function pendingEvalRuns(tx: Tx) {
  const { rows } = await tx.execute(
    sql`select id from eval_runs where status in ('queued','running') order by id limit 50`,
  );
  return rows.map((row) => EvalRun.shape.id.parse(row["id"]));
}

export async function saveEvalRunStatus(tx: Tx, runId: string, status: "passed" | "failed" | "error") {
  await tx.execute(sql`update eval_runs set status=${status} where id=${runId} and status='running'`);
}

export async function savedEvalTurn(tx: Tx, runId: string, caseId: string, index: number) {
  const row = (
    await tx.execute(sql`select detail from eval_turn_results where run_id=${runId} and case_id=${caseId}
    and turn_index=${index}`)
  ).rows[0];
  return row ? EvalTurnResult.parse(row["detail"]) : undefined;
}

export async function saveEvalTurn(tx: Tx, runId: string, caseId: string, detail: EvalTurnResult) {
  await tx.execute(sql`insert into eval_turn_results (workspace_id, run_id, case_id, turn_index, detail)
    values (${currentWorkspace}, ${runId}, ${caseId}, ${detail.index}, ${JSON.stringify(EvalTurnResult.parse(detail))}::jsonb)
    on conflict do nothing`);
}

export async function saveEvalResult(tx: Tx, runId: string, caseId: string, result: EvalResult) {
  await tx.execute(sql`insert into eval_results (workspace_id, run_id, case_id, detail)
    values (${currentWorkspace}, ${runId}, ${caseId}, ${JSON.stringify(EvalResult.parse(result))}::jsonb)
    on conflict do nothing`);
}

/** Internal Bridge ingress for the next scripted step. Cases share neither users nor conversations. */
export async function insertEvalInbound(
  tx: Tx,
  input: { runId: string; caseId: string; index: number; segment: number },
) {
  const row = (
    await tx.execute(sql`select bot_id as "botId", connection_id as "connectionId", cases, target
    from eval_runs where id=${input.runId} and status='running' for update`)
  ).rows[0];
  if (!row) throw new AppError("not_found");
  const {
    botId,
    connectionId,
    cases: snapshots,
    target,
  } = z
    .object({
      botId: z.string(),
      connectionId: z.string(),
      cases,
      target: EvalTarget,
    })
    .parse(row);
  const entry = snapshots.find((snapshot) => snapshot.id === input.caseId);
  const step = entry?.script.turns[input.index];
  if (!entry || !step) throw new AppError("not_found");

  const key = `case-${input.caseId}-${input.index}`;
  const prior = await findInboundByIdempotencyKey(tx, connectionId, key);
  if (prior) return EvalTurnReceipt.parse({ conversationId: prior.conversationId, turnId: prior.payload["turnId"] });

  const patch: Record<string, Json> = { ...entry.script.user?.attributes };
  for (const field of ["name", "email", "phone", "locale"] as const) {
    const value = entry.script.user?.[field];
    if (value !== undefined) patch[field] = value;
  }
  const user = await upsertEndUser(tx, { botId, connectionId, externalId: input.caseId, patch });
  const state = emptyState() as unknown as Record<string, Json>;
  const conversation = await ensureConversation(tx, {
    botId,
    connectionId,
    endUserId: user.id,
    externalId: `${input.caseId}-${input.segment}`,
    mode: "eval",
    state,
    stateBytes: Buffer.byteLength(JSON.stringify(state)),
    ...(target.kind === "version" ? { versionId: target.versionId } : {}),
  });
  const turnId = newId("turn");
  if (step.event) {
    const event = SendEventRequest.parse({ userId: user.externalId, ...step.event });
    await insertInbound(tx, {
      conversationId: conversation.id,
      kind: "event",
      idempotencyKey: key,
      payload: { name: event.name, payload: event.payload, turnId },
    });
  } else {
    const { message } = SendMessageRequest.parse({
      userId: user.externalId,
      message:
        step.postback === undefined ? { type: "text", text: step.user } : { type: "postback", value: step.postback },
    });
    const payload = message as unknown as Record<string, Json>;
    await insertUserMessage(tx, { conversationId: conversation.id, payload, type: message.type });
    await insertInbound(tx, {
      conversationId: conversation.id,
      kind: "message",
      idempotencyKey: key,
      payload: { message: payload, turnId },
    });
  }
  return EvalTurnReceipt.parse({ conversationId: conversation.id, turnId });
}
