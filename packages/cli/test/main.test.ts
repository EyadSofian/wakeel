import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { newId } from "@wakeel/contracts";
import { expect, test } from "vitest";
import { runCli } from "../src/main";

test.each([
  ["passed", 0],
  ["failed", 1],
  ["error", 1],
] as const)("returns the expected exit code for a %s API run", async (status, code) => {
  const workspace = newId("ws");
  const bot = newId("bot");
  const suiteId = newId("es");
  const id = newId("er");
  const root = `/v1/workspaces/${workspace}/bots/${bot}/evals`;
  const run = { id, suiteId, createdAt: "2026-11-15T12:00:00Z", target: { kind: "draft" } };
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(req.method === "POST" ? { ...run, status: "queued" } : { ...run, status, cases: [], results: [] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const output: string[] = [];
  try {
    expect(
      await runCli(
        ["evals", "run", "--bot", bot, "--suite", suiteId],
        {
          WAKEEL_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          WAKEEL_API_KEY: "fixture",
          WAKEEL_WORKSPACE_ID: workspace,
        },
        { print: (line) => output.push(line), error: (line) => output.push(line) },
      ),
    ).toBe(code);
    expect(calls).toEqual([
      `POST ${root}/suites/${suiteId}/runs Bearer fixture`,
      `GET ${root}/runs/${id} Bearer fixture`,
    ]);
    expect(output.join("\n")).not.toContain("fixture");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
