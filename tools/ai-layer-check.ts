import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ADR-056: a pull request that changes the AI layer cannot merge without a gate report in its
 * description. A failing gate blocks it, and a cost rise needs the `cost-approved` label, which only
 * a maintainer can add. The workflow passes the PR's files, body and labels as JSON on stdin.
 */

/** The AI layer, as ADR-056 defines it. */
const AI_LAYER = [
  /^packages\/autonomy\//,
  /^packages\/retrieval\//,
  /^packages\/llm\//,
  /^packages\/engine\/src\/cards\/ai-[^/]+\.ts$/,
  /^packages\/engine\/src\/cards\/kb-search\.ts$/,
  /^apps\/worker\/src\/turn\/autonomy\.ts$/,
  /^apps\/worker\/src\/kb\//,
  /^tools\/pilot\//,
];

const HEADER = "| Gate | Base | Candidate | Bar | Result |";

export function isAiLayerFile(path: string): boolean {
  return AI_LAYER.some((pattern) => pattern.test(path));
}

export interface CheckInput {
  files: readonly string[];
  body: string;
  labels: readonly string[];
}

export function aiLayerCheck(input: CheckInput): { aiLayer: boolean; ok: boolean; reasons: string[] } {
  const touched = input.files.filter(isAiLayerFile);
  if (touched.length === 0) return { aiLayer: false, ok: true, reasons: [] };
  const reasons: string[] = [];
  const at = input.body.indexOf(HEADER);
  if (at < 0) {
    reasons.push(
      `This PR changes the AI layer (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ", …" : ""}). ` +
        "Paste the output of `pnpm evals:gate compare` into the description (ADR-056).",
    );
    return { aiLayer: true, ok: false, reasons };
  }
  const table = input.body
    .slice(at)
    .split("\n")
    .filter((line) => line.startsWith("| G"));
  if (table.length === 0) reasons.push("The gate report has no gate rows. Paste the whole table.");
  const failing = table.filter((line) => line.includes("**fail**"));
  if (failing.length > 0)
    reasons.push(
      `A gate fails: ${failing.map((line) => line.split("|")[1]?.trim()).join(", ")}. Fix it before merging.`,
    );
  if (table.some((line) => line.includes("**needs approval**")) && !input.labels.includes("cost-approved"))
    reasons.push(
      "The cost per reply rose more than 20% (G6). A maintainer adds the `cost-approved` label to accept it.",
    );
  return { aiLayer: true, ok: reasons.length === 0, reasons };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    files: { path: string }[];
    body: string | null;
    labels: { name: string }[];
  };
  const result = aiLayerCheck({
    files: input.files.map((f) => f.path),
    body: input.body ?? "",
    labels: input.labels.map((l) => l.name),
  });
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  const text = !result.aiLayer
    ? "Not an AI-layer change; no gate report needed."
    : result.ok
      ? "AI-layer change with a passing gate report."
      : result.reasons.join("\n");
  if (summary) appendFileSync(summary, `${text}\n`);
  console.log(text);
  // The workflow labels the PR from this output.
  const output = process.env["GITHUB_OUTPUT"];
  if (output) appendFileSync(output, `ai_layer=${result.aiLayer}\n`);
  if (!result.ok) process.exitCode = 1;
}
