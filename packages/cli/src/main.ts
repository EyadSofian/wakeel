import { parseArgs } from "node:util";
import { BotId, EvalRun, EvalRunDetail, EvalSuiteId, EvalTarget, Problem, WorkspaceId } from "@wakeel/contracts";

const usage = "wakeel evals run --bot BOT_ID --suite SUITE_ID [--workspace WORKSPACE_ID] [--version VERSION_ID]";

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: { print(line: string): void; error(line: string): void },
  delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  if (argv.includes("--help") || argv.length === 0) {
    io.print(usage);
    return 0;
  }
  try {
    if (argv[0] !== "evals" || argv[1] !== "run") throw new Error(usage);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        bot: { type: "string" },
        suite: { type: "string" },
        workspace: { type: "string" },
        version: { type: "string" },
      },
    });
    const workspace = WorkspaceId.safeParse(values.workspace ?? env["WAKEEL_WORKSPACE_ID"]);
    const bot = BotId.safeParse(values.bot);
    const suite = EvalSuiteId.safeParse(values.suite);
    const target = EvalTarget.safeParse(
      values.version ? { kind: "version", versionId: values.version } : { kind: "draft" },
    );
    if (!workspace.success || !bot.success || !suite.success || !target.success) throw new Error(usage);
    const api = env["WAKEEL_API_URL"];
    const token = env["WAKEEL_API_KEY"];
    if (!api || !token)
      throw new Error("Set WAKEEL_API_URL and a workspace key with the eval.run scope in WAKEEL_API_KEY.");
    const origin = new URL(api);
    if (
      origin.username ||
      origin.password ||
      (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))
    ) {
      throw new Error("Use an HTTPS API URL. HTTP is allowed only on localhost.");
    }
    const root = `/v1/workspaces/${workspace.data}/bots/${bot.data}/evals`;
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(new URL(path, origin), {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const problem = Problem.safeParse(json);
        throw new Error(
          problem.success ? `${problem.data.title} ${problem.data.fix}` : `API request failed (${response.status}).`,
        );
      }
      return json;
    };
    const run = EvalRun.parse(await request(`${root}/suites/${suite.data}/runs`, target.data));
    io.print(`Run ${run.id}`);
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const result = EvalRunDetail.parse(await request(`${root}/runs/${run.id}`));
      if (result.status === "queued" || result.status === "running") {
        await delay(1000);
        continue;
      }
      const passed = result.results.filter((item) => item.result.status === "passed").length;
      io.print(`${result.status}: ${passed}/${result.cases.length} cases passed`);
      return result.status === "passed" ? 0 : 1;
    }
    throw new Error(`Timed out waiting for run ${run.id}. View it in Studio.`);
  } catch (error) {
    io.error(
      error instanceof Error && error.name !== "ZodError"
        ? error.message
        : "The API returned an invalid eval response.",
    );
    return 2;
  }
}
