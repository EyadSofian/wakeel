import type { VariableType } from "@wakeel/contracts";

/**
 * TypeScript types for the model's `tools.d.ts` (architecture §6.4 part 2), from the JSON Schema
 * subset the contracts allow (json-schema.ts). Descriptions become doc comments.
 */
type Schema = Record<string, unknown>;

export function schemaToTs(schema: Schema | undefined, indent = ""): string {
  if (!schema) return "unknown";
  const s = schema;
  if (Array.isArray(s["enum"])) return (s["enum"] as unknown[]).map((v) => JSON.stringify(v)).join(" | ") || "never";
  const type = s["type"];
  if (Array.isArray(type)) return type.map((t) => schemaToTs({ ...s, type: t }, indent)).join(" | ");
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = schemaToTs(s["items"] as Schema | undefined, indent);
      return item.includes(" | ") || item.includes("\n") ? `Array<${item}>` : `${item}[]`;
    }
    case "object": {
      const props = (s["properties"] ?? {}) as Record<string, Schema>;
      const required = new Set((s["required"] as string[] | undefined) ?? []);
      const entries = Object.entries(props);
      if (entries.length === 0) return "Record<string, unknown>";
      const inner = `${indent}  `;
      const lines = entries.map(([name, prop]) => {
        const doc = typeof prop["description"] === "string" ? `${inner}/** ${oneLine(prop["description"])} */\n` : "";
        const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
        return `${doc}${inner}${key}${required.has(name) ? "" : "?"}: ${schemaToTs(prop, inner)};`;
      });
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default:
      return "unknown";
  }
}

/** A variable or workflow field's type, from its variable type and optional schema. */
export function variableTypeToTs(type: VariableType, schema?: Schema): string {
  if (schema) return schemaToTs(schema);
  switch (type) {
    case "string":
    case "date":
    case "enum":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "Record<string, unknown>";
    case "array":
      return "unknown[]";
    case "any":
      return "unknown";
  }
}

export const oneLine = (text: string) => text.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();
