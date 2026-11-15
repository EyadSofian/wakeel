import { type AutonomousNode, type Json, validateJson } from "@wakeel/contracts";
import { z } from "zod";
import { contextFromNode, protocolV1 } from "../src/protocol/protocol-v1";
import type { ProtocolResult } from "../src/protocol/types";
import type { AdherenceCase } from "./cases";

const ToolCall = z.object({ name: z.string(), input: z.unknown() });
const CaseResult = z.object({
  caseId: z.string(),
  language: z.enum(["en", "ar"]),
  tags: z.array(z.string()),
  protocolValid: z.boolean(),
  behaviorValid: z.boolean(),
  issue: z.string().optional(),
  response: z.string().optional(),
  calls: z.array(ToolCall).optional(),
});
export type CaseResult = z.infer<typeof CaseResult>;

export interface EvalPorts {
  model: string;
  workspaceId: string;
  cases: readonly AdherenceCase[];
  now(): number;
  stream(request: {
    model: string;
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    stop: string[];
    temperature: number;
    maxOutputTokens: number;
    purpose: string;
    context: { workspaceId: string; mode: "eval" };
  }): { textStream: AsyncIterable<string>; result: Promise<{ text: string; finishReason: string }> };
  execute(request: { source: string; node: AutonomousNode; caseId: string }): Promise<{
    ok: boolean;
    calls: z.infer<typeof ToolCall>[];
    patches?: Record<string, { set?: Record<string, Json>; unset?: string[] }>;
  }>;
  progress?(result: CaseResult): void;
}

/** Grades the first raw response: recovery and length truncation never count as protocol adherence. */
export function gradeResponse(c: AdherenceCase, response: string, finishReason: string) {
  const reader = protocolV1.createReader(contextFromNode(c.node));
  reader.push(response);
  const parsed = reader.end(finishReason === "length" || finishReason === "error" ? finishReason : "stop").result;
  const protocolValid = !parsed.issue && !parsed.recovered && finishReason === "stop";
  const actualExit = parsed.exit?.kind === "exit" ? parsed.exit.name : parsed.exit?.kind;
  const expected = c.expected;
  const text = parsed.messages.map((m) => (m.type === "text" || m.type === "choice" ? m.text : "")).join("\n");
  const behaviorValid =
    protocolValid &&
    (!expected.exit || expected.exit === actualExit) &&
    (!expected.messageType || parsed.messages.some((m) => m.type === expected.messageType)) &&
    (!(expected.exit === "resolved" && expected.reference) ||
      (parsed.exit?.kind === "exit" &&
        typeof parsed.exit.data === "object" &&
        parsed.exit.data !== null &&
        !Array.isArray(parsed.exit.data) &&
        parsed.exit.data["reference"] === expected.reference)) &&
    (!c.tags.includes("read-variable") || text.includes(expected.reference ?? "")) &&
    (expected.tools.length > 0 || !!expected.topic || !parsed.run);
  return { protocolValid, behaviorValid, parsed };
}

/** Uses exact counts rather than rounded percentages for the architecture §6.6 98% gate. */
export function summarize(results: readonly CaseResult[]) {
  const count = (rows: readonly CaseResult[]) => ({
    total: rows.length,
    protocolValid: rows.filter((r) => r.protocolValid).length,
    behaviorValid: rows.filter((r) => r.behaviorValid).length,
  });
  const totals = count(results);
  const byTag = Object.fromEntries(
    [...new Set(results.flatMap((r) => r.tags))]
      .sort()
      .map((tag) => [tag, count(results.filter((r) => r.tags.includes(tag)))]),
  );
  return {
    ...totals,
    autonomy:
      totals.total === 0
        ? ("untested" as const)
        : totals.protocolValid * 100 >= totals.total * 98
          ? ("supported" as const)
          : ("unsupported" as const),
    byLanguage: {
      en: count(results.filter((r) => r.language === "en")),
      ar: count(results.filter((r) => r.language === "ar")),
    },
    byTag,
  };
}

function toolCallsMatch(c: AdherenceCase, calls: z.infer<typeof ToolCall>[]) {
  return (
    JSON.stringify(calls.map((call) => call.name)) === JSON.stringify(c.expected.tools) &&
    calls.every((call) => {
      const tool = c.node.tools.find((t) => t.name === call.name);
      return (
        tool?.type === "code" &&
        validateJson(tool.input, call.input).length === 0 &&
        (!c.expected.reference || (call.input as Record<string, unknown>)["reference"] === c.expected.reference)
      );
    })
  );
}

/** Runs one unassisted response per fixture. Execution is a port; this package never evaluates code. */
export async function runSuite(ports: EvalPorts) {
  const startedAt = new Date(ports.now()).toISOString();
  const results: CaseResult[] = [];
  for (const c of ports.cases) {
    const prompt = c.prompt();
    const handle = ports.stream({
      model: ports.model,
      system: prompt.system,
      messages: prompt.messages,
      stop: [...protocolV1.stopSequences],
      temperature: 0,
      maxOutputTokens: 1200,
      purpose: "autonomy_adherence",
      context: { workspaceId: ports.workspaceId, mode: "eval" },
    });
    // Observe both promises: a provider rejection must not become an unhandled rejection while streaming.
    const consume = async () => {
      let text = "";
      for await (const chunk of handle.textStream) text += chunk;
      return text;
    };
    const [response, completion] = await Promise.all([consume(), handle.result]);
    const grade = gradeResponse(c, response, completion.finishReason);
    const parsed: ProtocolResult = grade.parsed;
    let calls: z.infer<typeof ToolCall>[] = [];
    let behaviorValid = grade.behaviorValid;
    if (grade.protocolValid && parsed.run) {
      const execution = await ports.execute({ source: parsed.run.code, node: c.node, caseId: c.id });
      calls = execution.calls;
      behaviorValid &&= execution.ok && toolCallsMatch(c, calls);
      // Mirror the node's grant boundary in the behavioural score; sandbox patches are proposals.
      for (const [scope, patch] of Object.entries(execution.patches ?? {})) {
        if (scope === "memo" || scope === "turn") continue;
        behaviorValid &&=
          scope === "conversation" &&
          !!c.expected.topic &&
          Object.keys(patch.set ?? {}).every((key) => key === "topic") &&
          !patch.unset?.length;
      }
      if (c.expected.topic) behaviorValid &&= execution.patches?.["conversation"]?.set?.["topic"] === c.expected.topic;
    } else if (c.expected.tools.length > 0 || c.expected.topic) behaviorValid = false;
    const result = CaseResult.parse({
      caseId: c.id,
      language: c.language,
      tags: c.tags,
      protocolValid: grade.protocolValid,
      behaviorValid,
      response,
      calls,
      ...(parsed.issue ? { issue: parsed.issue.code } : parsed.recovered ? { issue: "protocol_recovered" } : {}),
    });
    results.push(result);
    ports.progress?.(result);
  }
  return {
    model: ports.model,
    startedAt,
    finishedAt: new Date(ports.now()).toISOString(),
    results,
    summary: summarize(results),
  };
}
