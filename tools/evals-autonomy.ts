/** Task 6.10: real-model I/O stays outside the pure autonomy package. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { AppError, newId, validateJson } from "@wakeel/contracts";
import { createLlm, loadRegistry, registry, type UsageEvent } from "@wakeel/llm";
import { createAutonomyRunPort, createSandboxClient } from "@wakeel/sandbox-client";
import { adherenceCases, toolResult } from "../packages/autonomy/evals/cases";
import { runSuite } from "../packages/autonomy/evals/runner";

const credentialNames = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
} as const;

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string", multiple: true },
      "env-file": { type: "string" },
      sandbox: { type: "string", default: "http://127.0.0.1:4300" },
      output: { type: "string", default: "packages/autonomy/evals/reports" },
      "update-registry": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "pnpm evals:autonomy --env-file /path/to/.env --model <registry-id> [--model <id>] [--sandbox http://127.0.0.1:4300] [--update-registry]",
    );
    return;
  }
  if (values["env-file"]) loadEnvFile(resolve(values["env-file"]));
  const candidates =
    values.model?.map((id) => registry.get(id)) ??
    registry.models().filter((m) => m.kind === "chat" && process.env[credentialNames[m.provider]]);
  if (!candidates.length) throw new AppError("model_key_missing", { provider: "candidate model" });
  const ready = await fetch(new URL("/health/ready", values.sandbox), { signal: AbortSignal.timeout(5000) });
  if (!ready.ok) throw new AppError("internal_error", {}, { detail: "The eval sandbox is not ready." });
  const workspaceId = newId("ws");
  const output = resolve(values.output);
  await mkdir(output, { recursive: true });
  // Only authored fixture data contributes to the fingerprint; generated element ids do not.
  const suiteHash = createHash("sha256")
    .update(
      JSON.stringify(
        adherenceCases.map((c) => ({
          id: c.id,
          user: c.user,
          instruction: c.instruction,
          feedback: c.feedback,
          expected: c.expected,
        })),
      ),
    )
    .digest("hex");
  const sandbox = createAutonomyRunPort(createSandboxClient({ url: values.sandbox }));
  const secrets = Object.values(credentialNames).flatMap((name) =>
    process.env[name] ? [process.env[name] as string] : [],
  );
  const scrub = (text: string) => secrets.reduce((out, key) => out.replaceAll(key, "[redacted]"), text);
  let failed = false;
  for (const candidate of candidates) {
    if (candidate.kind !== "chat") throw new AppError("model_not_configured");
    const usage: UsageEvent[] = [];
    // Never let fallback responses certify the requested model.
    const fixedRegistry = loadRegistry({ models: registry.models().map((m) => ({ ...m, fallback: [] })) });
    const llm = createLlm({
      registry: fixedRegistry,
      credentials: {
        workspaceKey: async (_ws, provider) => {
          const apiKey = process.env[credentialNames[provider]];
          return apiKey
            ? {
                apiKey,
                ...(provider === "openai-compatible" ? { baseURL: process.env["OPENAI_COMPATIBLE_BASE_URL"] } : {}),
              }
            : undefined;
        },
        platformKey: async () => undefined,
        platformKeysAllowed: async () => false,
      },
      onUsage: async (event) => {
        usage.push(event);
      },
    });
    console.log(`Evaluating ${candidate.id}: ${adherenceCases.length} synthetic cases`);
    const report = await runSuite({
      model: candidate.id,
      workspaceId,
      cases: adherenceCases,
      now: Date.now,
      stream: (request) => llm.stream({ ...request, signal: AbortSignal.timeout(60_000) }),
      execute: async (request) => {
        const calls: { name: string; input: unknown }[] = [];
        const c = adherenceCases.find((entry) => entry.id === request.caseId);
        const result = await sandbox.run({
          source: request.source,
          scopes: {
            conversation: { topic: c?.expected.reference ?? "support" },
            workflow: {},
            user: {},
            turn: {},
            memo: {},
            bot: {},
            event: {},
            env: {},
          },
          tools: request.node.tools.map((t) => ({ name: t.name })),
          timeoutMs: 3000,
          memoryMb: 64,
          idempotencyKey: `adherence:${candidate.id}:${request.caseId}`,
          signal: AbortSignal.timeout(5000),
          onTool: async (call) => {
            calls.push({ name: call.tool, input: call.input });
            const tool = request.node.tools.find((t) => t.name === call.tool);
            if (tool?.type !== "code" || validateJson(tool.input, call.input).length)
              throw new AppError("tool_input_invalid");
            const reference =
              call.input && typeof call.input === "object" && !Array.isArray(call.input)
                ? (call.input["reference"] ?? null)
                : null;
            return toolResult(reference);
          },
        });
        return { ok: result.ok, calls, ...(result.ok ? { patches: result.patches } : {}) };
      },
      progress: (r) =>
        console.log(`${candidate.id} ${r.caseId}: protocol=${r.protocolValid} behavior=${r.behaviorValid}`),
    });
    const path = resolve(output, `${candidate.id.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}.json`);
    await writeFile(path, scrub(`${JSON.stringify({ ...report, suiteHash, promptVersion: 1, usage }, null, 2)}\n`));
    console.log(
      `${candidate.id}: ${report.summary.protocolValid}/240 protocol-valid; ${report.summary.behaviorValid}/240 behavior-valid; ${report.summary.autonomy}`,
    );
    if (report.summary.autonomy !== "supported") failed = true;
    if (values["update-registry"]) {
      // A partial run or provider failure never reaches this point.
      const registryPath = new URL("../packages/llm/src/models.json", import.meta.url);
      const raw: unknown = JSON.parse(await readFile(registryPath, "utf8"));
      const checked = loadRegistry(raw);
      const models = checked
        .models()
        .map((model) => (model.id === candidate.id ? { ...model, autonomy: report.summary.autonomy } : model));
      const source = raw as { $comment?: string };
      await writeFile(registryPath, `${JSON.stringify({ ...source, models }, null, 2)}\n`);
    }
  }
  if (failed) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  // Provider exceptions can contain request headers. Print only catalogued errors, never causes.
  const problem = error instanceof AppError ? error : new AppError("internal_error");
  console.error(`${problem.code}: ${problem.title}. ${problem.fix}`);
  process.exitCode = 1;
});
