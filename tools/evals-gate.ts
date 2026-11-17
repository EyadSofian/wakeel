import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type GateSide, gateReport } from "../packages/evals/src/index";

/**
 * The quality gate command (ADR-056, task 12.5).
 *
 *   pnpm evals:gate run --ref <git ref> --out <dir> --env-file model.env --env-file reranker.env
 *     Measures one ref in a temporary worktree: both retrieval sets and the adherence corpus.
 *   pnpm evals:gate compare --base <dir> --candidate <dir> [--strongest gpt-6.1-sol] [--out report.md]
 *     Compares two measured folders against the ADR-056 bars and prints the report to paste in the PR.
 *
 * A measured folder holds `retrieval-synthetic.json`, `retrieval-realistic.json`,
 * `adherence/<model>.json`, `bots/*.json` (a suite run's detail from the API, with `suite` and `model`
 * added) and `judge/*.json` (a `judgeAgreement` result with `suite`). Bot suites run against a
 * deployed version, so they are exported into the folder rather than run here.
 */

/** Reads one measured folder; a report that is missing stays missing, and the gate says "not measured". */
export function readSide(dir: string): GateSide {
  const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  const list = (sub: string) =>
    existsSync(join(dir, sub))
      ? readdirSync(join(dir, sub))
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) => json(join(dir, sub, f)))
      : [];
  const side: GateSide = {};
  if (existsSync(join(dir, "retrieval-synthetic.json")))
    side.synthetic = json(join(dir, "retrieval-synthetic.json")) as GateSide["synthetic"];
  if (existsSync(join(dir, "retrieval-realistic.json")))
    side.realistic = json(join(dir, "retrieval-realistic.json")) as GateSide["realistic"];
  // The adherence runner writes one report per model; a report with no completed run has no summary.
  const adherence = list("adherence").filter(
    (r): r is NonNullable<GateSide["adherence"]>[number] =>
      typeof r === "object" && r !== null && "summary" in r && typeof (r as { summary: unknown }).summary === "object",
  );
  if (adherence.length) side.adherence = adherence;
  const bots = list("bots") as GateSide["bots"];
  if (bots?.length) side.bots = bots;
  const judge = list("judge") as GateSide["judge"];
  if (judge?.length) side.judge = judge;
  return side;
}

function sh(command: string, args: string[], cwd: string): boolean {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  return result.status === 0;
}

function run(values: { ref?: string; out?: string; "env-file"?: string[]; model?: string; "rewrite-model"?: string }) {
  if (!values.ref || !values.out) throw new Error("run needs --ref and --out");
  const out = resolve(values.out);
  mkdirSync(join(out, "adherence"), { recursive: true });
  const envs = (values["env-file"] ?? []).flatMap((f) => ["--env-file", resolve(f)]);
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const tree = mkdtempSync(join(tmpdir(), "wakeel-gate-"));
  try {
    if (!sh("git", ["worktree", "add", "--detach", tree, values.ref], root))
      throw new Error(`cannot check out ${values.ref}`);
    if (!sh("pnpm", ["install", "--frozen-lockfile"], tree)) throw new Error("pnpm install failed");
    // Each suite that fails to run is left out of the folder, so the report says "not measured".
    sh(
      "pnpm",
      ["evals:retrieval", "--set", "synthetic", ...envs, "--output", join(out, "retrieval-synthetic.json")],
      tree,
    );
    sh(
      "pnpm",
      [
        "evals:retrieval",
        "--set",
        "realistic",
        ...(values["rewrite-model"] ? ["--rewrite-model", values["rewrite-model"]] : []),
        ...envs,
        "--output",
        join(out, "retrieval-realistic.json"),
      ],
      tree,
    );
    const firstEnv = values["env-file"]?.[0];
    if (values.model && firstEnv)
      sh(
        "pnpm",
        [
          "evals:autonomy",
          "--model",
          values.model,
          "--env-file",
          resolve(firstEnv),
          "--output",
          join(out, "adherence"),
        ],
        tree,
      );
  } finally {
    sh("git", ["worktree", "remove", "--force", tree], root);
    rmSync(tree, { recursive: true, force: true });
  }
}

function compare(values: { base?: string; candidate?: string; strongest?: string; out?: string }) {
  if (!values.base || !values.candidate) throw new Error("compare needs --base and --candidate");
  const report = gateReport(readSide(resolve(values.base)), readSide(resolve(values.candidate)), {
    strongestModel: values.strongest ?? "gpt-6.1-sol",
  });
  const text = `## Gate report (ADR-056)\n\n${report.markdown}\n`;
  if (values.out) writeFileSync(resolve(values.out), text);
  console.log(text);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      ref: { type: "string" },
      out: { type: "string" },
      "env-file": { type: "string", multiple: true },
      model: { type: "string" },
      "rewrite-model": { type: "string" },
      base: { type: "string" },
      candidate: { type: "string" },
      strongest: { type: "string" },
    },
  });
  try {
    if (mode === "run") run(values);
    else if (mode === "compare") compare(values);
    else {
      console.log(
        "pnpm evals:gate run --ref <ref> --out <dir> --env-file <file> [--model <id>] [--rewrite-model <id>]",
      );
      console.log("pnpm evals:gate compare --base <dir> --candidate <dir> [--strongest <id>] [--out report.md]");
      process.exitCode = mode ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "The gate did not complete");
    process.exitCode = 1;
  }
}
