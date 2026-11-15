import {
  AppError,
  BotId,
  EvalCase,
  EvalCaseEntry,
  EvalCaseId,
  EvalRun,
  EvalRunDetail,
  EvalRunId,
  EvalSuite,
  EvalSuiteId,
  EvalTarget,
  NewEvalSuite,
} from "@wakeel/contracts";
import {
  assembleDraft,
  createEvalRun,
  createEvalSuite,
  evalPublishStatus,
  getEvalRun,
  getEvalSuite,
  listEvalRuns,
  listEvalSuites,
  saveEvalCase,
} from "@wakeel/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission, type StudioDeps } from "../studio";

export interface EvalRoutesDeps {
  enqueue(input: { workspaceId: string; runId: string }): Promise<void>;
}
const bot = z.object({ botId: BotId });
const suite = bot.extend({ suiteId: EvalSuiteId });
const item = suite.extend({ caseId: EvalCaseId });
const run = bot.extend({ runId: EvalRunId });
const limit = z.coerce.number().int().min(1).max(100).default(30);
const suiteDetail = EvalSuite.extend({ cases: z.array(EvalCaseEntry) });

export async function evalRoutes(
  app: FastifyInstance,
  { studio, queue }: { studio: StudioDeps; queue: EvalRoutesDeps },
) {
  const root = "/v1/workspaces/:workspaceId/bots/:botId/evals";
  app.get(`${root}/publish-status`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "bot.read");
    const { botId } = bot.parse(req.params);
    return studio.db.withWorkspace(workspaceId, async (tx) =>
      evalPublishStatus(tx, botId, await assembleDraft(tx, botId)),
    );
  });
  app.get(`${root}/suites`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId } = bot.parse(req.params);
    const query = z.object({ cursor: EvalSuiteId.optional(), limit }).parse(req.query);
    return studio.db.withWorkspace(workspaceId, (tx) => listEvalSuites(tx, botId, query.cursor, query.limit));
  });
  app.post(`${root}/suites`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId } = bot.parse(req.params);
    const { name } = NewEvalSuite.parse(req.body);
    const result = await studio.db.withWorkspace(workspaceId, (tx) => createEvalSuite(tx, botId, name));
    return reply.code(201).header("etag", `"${result.revision}"`).send(EvalSuite.parse(result));
  });
  app.get(`${root}/suites/:suiteId`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId, suiteId } = suite.parse(req.params);
    return suiteDetail.parse(await studio.db.withWorkspace(workspaceId, (tx) => getEvalSuite(tx, botId, suiteId)));
  });
  app.post(`${root}/suites/:suiteId/cases`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId, suiteId } = suite.parse(req.params);
    const body = EvalCase.parse(req.body);
    const result = await studio.db.withWorkspace(workspaceId, (tx) => saveEvalCase(tx, botId, suiteId, body));
    return reply.code(201).header("etag", `"${result.revision}"`).send(EvalCaseEntry.parse(result));
  });
  app.put(`${root}/suites/:suiteId/cases/:caseId`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId, suiteId, caseId } = item.parse(req.params);
    const tag = req.headers["if-match"];
    const match = typeof tag === "string" ? /^"(\d{1,9})"$/.exec(tag) : null;
    if (!match) throw new AppError("validation_failed", {}, { detail: "Send the edited case revision in If-Match." });
    const body = EvalCase.parse(req.body);
    const result = await studio.db.withWorkspace(workspaceId, (tx) =>
      saveEvalCase(tx, botId, suiteId, body, { id: caseId, expected: Number(match[1]) }),
    );
    return reply.header("etag", `"${result.revision}"`).send(EvalCaseEntry.parse(result));
  });
  app.get(`${root}/suites/:suiteId/runs`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId, suiteId } = suite.parse(req.params);
    const query = z.object({ cursor: EvalRunId.optional(), limit }).parse(req.query);
    return studio.db.withWorkspace(workspaceId, (tx) => listEvalRuns(tx, botId, suiteId, query.cursor, query.limit));
  });
  app.post(`${root}/suites/:suiteId/runs`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId, suiteId } = suite.parse(req.params);
    const target = EvalTarget.parse(req.body);
    const created = await studio.db.withWorkspace(workspaceId, (tx) => createEvalRun(tx, botId, suiteId, target));
    await queue
      .enqueue({ workspaceId, runId: created.id })
      .catch(() => req.log.warn({ runId: created.id }, "Eval dispatch will be retried by maintenance"));
    return reply.code(202).send(EvalRun.parse(created));
  });
  app.get(`${root}/runs/:runId`, async (req, reply) => {
    const { workspaceId } = await requirePermission(studio, req, reply, "eval.run");
    const { botId, runId } = run.parse(req.params);
    return reply
      .header("cache-control", "no-store")
      .send(EvalRunDetail.parse(await studio.db.withWorkspace(workspaceId, (tx) => getEvalRun(tx, botId, runId))));
  });
}
