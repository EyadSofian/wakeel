import { EvalCaseEntry, EvalRun, EvalRunDetail, EvalSuite } from "@wakeel/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { evalRoutes } from "../src/routes/evals";
import { type Stack, signUp, startStack } from "./stack";

let stack: Stack;
const jobs: { workspaceId: string; runId: string }[] = [];
beforeAll(async () => {
  stack = await startStack({
    extraRoutes: (app, studio) => {
      void app.register(evalRoutes, {
        studio,
        queue: {
          enqueue: async (job) => {
            jobs.push(job);
          },
        },
      });
    },
  });
});
afterAll(async () => {
  await stack?.stop();
});

test("authorizes eval runs, captures the Arabic case revision and dispatches a scoped job", async () => {
  const owner = await signUp(stack.app);
  const stranger = await signUp(stack.app);
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "Evals", slug: "evals" })).json().id as string;
  const other = (await stranger.send("POST", "/v1/workspaces", { name: "Other", slug: "other" })).json().id as string;
  const bot = (await owner.send("POST", `/v1/workspaces/${ws}/bots`, { name: "متجر", slug: "shop" })).json()
    .id as string;
  const base = `/v1/workspaces/${ws}/bots/${bot}/evals`;
  const created = await owner.send("POST", `${base}/suites`, { name: "الطلبات" });
  expect(created.statusCode, created.body).toBe(201);
  const suite = EvalSuite.parse(created.json());
  const script = { name: "الفاتورة", turns: [{ user: "ابعت invoice ORD-12" }] };
  const saved = await owner.send("POST", `${base}/suites/${suite.id}/cases`, script);
  expect(saved.statusCode, saved.body).toBe(201);
  const entry = EvalCaseEntry.parse(saved.json());
  const started = await owner.send("POST", `${base}/suites/${suite.id}/runs`, { kind: "draft" });
  expect(started.statusCode, started.body).toBe(202);
  const run = EvalRun.parse(started.json());
  expect(jobs).toEqual([{ workspaceId: ws, runId: run.id }]);
  const result = await owner.get(`${base}/runs/${run.id}`);
  expect(result.statusCode, result.body).toBe(200);
  expect(EvalRunDetail.parse(result.json()).cases).toEqual([entry]);
  const hidden = await stranger.get(`/v1/workspaces/${other}/bots/${bot}/evals/runs/${run.id}`);
  expect(hidden.statusCode).toBe(404);
});
