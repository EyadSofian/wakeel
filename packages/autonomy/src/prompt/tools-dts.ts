import type { AutonomousNode, BotDefinition, TableOperation, Tool } from "@wakeel/contracts";
import { oneLine, schemaToTs, variableTypeToTs } from "./schema-ts";

/**
 * `tools.d.ts` (architecture §6.4 part 2): every tool on the node as a typed function on `tools`, with
 * its description as the doc comment. Only listed tools exist (CLAUDE.md §9: no implicit tools).
 */
export function toolsDts(node: AutonomousNode, definition: BotDefinition): string {
  if (node.tools.length === 0) return "declare const tools: {};";
  const members = node.tools.map((t) => member(t, definition)).join("\n\n");
  return `declare const tools: {\n${members}\n};`;
}

function doc(lines: string[]): string {
  return lines.length === 1 ? `  /** ${lines[0]} */` : `  /**\n${lines.map((l) => `   * ${l}`).join("\n")}\n   */`;
}

const tableMethods: Record<TableOperation, string> = {
  find: "find(args: { where?: Record<string, unknown>; search?: string; sort?: { column: string; direction?: 'asc' | 'desc' }[]; limit?: number }): Promise<Record<string, unknown>[]>;",
  get: "get(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;",
  insert: "insert(args: { values: Record<string, unknown> }): Promise<Record<string, unknown>>;",
  update: "update(args: { where: Record<string, unknown>; values: Record<string, unknown> }): Promise<number>;",
  upsert: "upsert(args: { values: Record<string, unknown>; on: string }): Promise<Record<string, unknown>>;",
  delete: "delete(args: { where: Record<string, unknown> }): Promise<number>;",
};

function member(tool: Tool, definition: BotDefinition): string {
  const description = oneLine(tool.description);
  switch (tool.type) {
    case "code": {
      const notes = [
        description,
        ...(tool.sideEffects ? ["Changes things outside the conversation; never called twice for you."] : []),
      ];
      return `${doc(notes)}\n  ${tool.name}(input: ${schemaToTs(tool.input, "  ")}): Promise<${schemaToTs(tool.output, "  ")}>;`;
    }
    case "kb_search":
      return `${doc([description, "Returns passages; cite one by writing its token, for example [[c1]]."])}\n  ${tool.name}(query: string): Promise<Array<{ token: string; text: string; title: string }>>;`;
    case "table": {
      const ops = tool.operations.map((op) => `    ${tableMethods[op]}`).join("\n");
      return `${doc([description])}\n  ${tool.name}: {\n${ops}\n  };`;
    }
    case "workflow": {
      const wf = definition.workflows.find((w) => w.id === tool.workflowId);
      const fields = (list: typeof wf extends undefined ? never : NonNullable<typeof wf>["inputs"]) =>
        list.length === 0
          ? "Record<string, never>"
          : `{ ${list.map((f) => `${f.name}${f.required ? "" : "?"}: ${variableTypeToTs(f.type, f.schema as never)}`).join("; ")} }`;
      // ADR-035: every workflow call ends the code at the call site; the outputs come in the next step.
      const notes = [
        description,
        "Calling it ends your code at this call, and you get its outputs in your next step; call it last.",
        `Outputs: ${fields(wf?.outputs ?? [])}`,
      ];
      return `${doc(notes)}\n  ${tool.name}(input: ${fields(wf?.inputs ?? [])}): Promise<never>;`;
    }
  }
}
