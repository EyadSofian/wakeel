import {
  AppError,
  type AutonomousNode,
  type BotDefinition,
  type IoField,
  type Json,
  validateJson,
} from "@wakeel/contracts";
import { ToolSuspended, toolCallIdFor } from "./suspension";

/**
 * One tool call from the model's run block (architecture §6.5, ADR-032 §2, ADR-035). The tool must
 * be on the node and its input must match its signature before anything runs. A code tool runs as
 * its own sandbox exec and only returns a value; a workflow tool ends the run block at the call
 * site by throwing `ToolSuspended`; knowledge base and table tools are not built yet (Phases 8, 9).
 */

/** The parts of a Code exec a tool needs: the engine's `CodePort`, structurally (CLAUDE.md §4). */
export interface ToolCodeRunner {
  run(request: {
    source: string;
    scopes: Record<string, Json>;
    timeoutMs: number;
    memoryMb: number;
    idempotencyKey: string;
    secretKeys: string[];
  }): Promise<ToolCodeOutcome>;
}

export type ToolCodeOutcome =
  | { ok: true; value: Json | null; patches: Record<string, unknown>; said: unknown[] }
  | { ok: false; message: string };

export interface ToolDeps {
  definition: BotDefinition;
  code: ToolCodeRunner;
  /** The node's scopes, read by code tools (they cannot write them). */
  scopes: Record<string, Json>;
  /** The run block's idempotency key (`turnId:stepSeq:run`). */
  idempotencyKey: string;
  warn(message: string, data: Record<string, Json>): void;
}

const TOOL_MEMORY_MB = 64;

export async function callTool(
  node: AutonomousNode,
  call: { tool: string; operation?: string; input: Json },
  deps: ToolDeps,
): Promise<Json> {
  const tool = node.tools.find((t) => t.name === call.tool);
  if (!tool) throw new AppError("tool_failed", { tool: call.tool, message: "this node has no such tool" });
  switch (tool.type) {
    case "code": {
      const issues = validateJson(tool.input as Record<string, unknown>, call.input);
      if (issues.length > 0)
        throw new AppError("tool_input_invalid", { tool: tool.name, message: describeIssues(issues) });
      const outcome = await deps.code.run({
        // On the code's first line, so the line numbers in its errors stay the builder's own.
        source: `const input = ${JSON.stringify(call.input)}; ${tool.source}`,
        scopes: deps.scopes,
        timeoutMs: tool.timeoutMs,
        memoryMb: TOOL_MEMORY_MB,
        idempotencyKey: `${deps.idempotencyKey}:${tool.name}`,
        secretKeys: [],
      });
      if (!outcome.ok) throw new AppError("tool_failed", { tool: tool.name, message: outcome.message });
      if (Object.keys(outcome.patches).length > 0 || outcome.said.length > 0)
        deps.warn("a tool changed variables or sent messages; tools only return a value, so this was not applied", {
          tool: tool.name,
        });
      if (tool.output) {
        const out = validateJson(tool.output as Record<string, unknown>, outcome.value);
        if (out.length > 0)
          throw new AppError("tool_failed", {
            tool: tool.name,
            message: `it returned a value that does not match its output: ${describeIssues(out)}`,
          });
      }
      return outcome.value;
    }
    case "workflow": {
      const workflow = deps.definition.workflows.find((w) => w.id === tool.workflowId && w.kind === "sub");
      if (!workflow) throw new AppError("tool_failed", { tool: tool.name, message: "its workflow no longer exists" });
      const inputs = workflowInputs(tool.name, workflow.inputs, call.input);
      throw new ToolSuspended({
        toolId: tool.id,
        name: tool.name,
        workflowId: workflow.id,
        input: inputs,
        toolCallId: toolCallIdFor(deps.idempotencyKey, tool.name),
      });
    }
    case "kb_search":
      throw new AppError("tool_failed", { tool: tool.name, message: "knowledge base search is not available yet" });
    case "table":
      throw new AppError("tool_failed", { tool: tool.name, message: "tables are not available yet" });
  }
}

/**
 * Checks a workflow tool's input against the workflow's declared inputs, so a bad call is the
 * model's to fix at the call site rather than a failure of the node (the engine checks again).
 */
function workflowInputs(tool: string, fields: readonly IoField[], input: Json): Record<string, Json> {
  const refuse = (message: string) => new AppError("tool_input_invalid", { tool, message });
  const given = input ?? {};
  if (typeof given !== "object" || Array.isArray(given)) throw refuse("the input must be an object");
  for (const name of Object.keys(given))
    if (!fields.some((f) => f.name === name)) throw refuse(`${name} is not an input of this workflow`);
  const inputs: Record<string, Json> = {};
  for (const field of fields) {
    const value = (given as Record<string, Json>)[field.name];
    if (value === undefined || value === null) {
      if (field.required) throw refuse(`${field.name} is required`);
      continue;
    }
    if (!fitsType(value, field.type)) throw refuse(`${field.name} must be ${article(field.type)}`);
    if (field.schema) {
      const issues = validateJson(field.schema as Record<string, unknown>, value);
      if (issues.length > 0) throw refuse(`${field.name}: ${describeIssues(issues)}`);
    }
    inputs[field.name] = value;
  }
  return inputs;
}

function fitsType(value: Json, type: IoField["type"]): boolean {
  switch (type) {
    case "string":
    case "enum":
      return typeof value === "string";
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value));
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "any":
      return true;
  }
}

const article = (type: string) => (/^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`);

function describeIssues(issues: readonly { path: string; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => (i.path ? `${i.path} ${i.message}` : i.message))
    .join("; ");
}
