import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Accepted,
  BridgeConnection,
  BridgeConversation,
  BridgeDelivery,
  BridgeEvent,
  BridgeUser,
  Message,
  Problem,
  TurnResult,
} from "@wakeel/contracts";
import { expect } from "vitest";
import { parse } from "yaml";
import type { z } from "zod";
import type { App } from "../src/app";

/** Contract tests generated from the OpenAPI file (tasks 4.5, 5.3): shared by the Bridge test files. */

export const spec = parse(
  readFileSync(fileURLToPath(new URL("../../../docs/04-contracts/bridge-api.openapi.yaml", import.meta.url)), "utf8"),
) as { paths: Record<string, Record<string, OpenApiOperation>> };

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, { $ref?: string; content?: Record<string, { schema: Record<string, unknown> }> }>;
}

/** OpenAPI schema names → the zod schemas `openapi-agreement.test.ts` proves equal to them. */
const ZOD_FOR: Record<string, z.ZodType> = {
  Accepted,
  TurnResult,
  User: BridgeUser,
  Conversation: BridgeConversation,
  Message,
  BridgeEvent,
  Problem,
  Delivery: BridgeDelivery,
  Connection: BridgeConnection,
};

export function operation(operationId: string): { method: string; path: string; op: OpenApiOperation } {
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op === "object" && op && "operationId" in op && op.operationId === operationId)
        return { method, path, op };
    }
  }
  throw new Error(`OpenAPI has no operation ${operationId}`);
}

/** Validates a response against the OpenAPI response for its status: documented, and the body matches. */
export function expectConforms(operationId: string, res: Awaited<ReturnType<App["inject"]>>) {
  const { op } = operation(operationId);
  const documented = op.responses?.[String(res.statusCode)];
  expect(documented, `${operationId} does not document ${res.statusCode}: ${res.body}`).toBeDefined();
  if (documented?.$ref) {
    expect(res.headers["content-type"]).toContain("application/problem+json");
    Problem.parse(res.json());
    return;
  }
  const schema = documented?.content?.["application/json"]?.schema;
  if (!schema) return;
  const ref = (s: Record<string, unknown>) => String(s["$ref"]).split("/").at(-1) as string;
  if (schema["$ref"]) {
    const zod = ZOD_FOR[ref(schema)];
    expect(zod, `no zod schema mapped for ${ref(schema)}`).toBeDefined();
    zod?.parse(res.json());
    return;
  }
  const properties = schema["properties"] as Record<string, { type?: string; items?: Record<string, unknown> }>;
  // Inline plain objects (testWebhook): every required key present, each with its declared type.
  if (!properties["data"]) {
    const body = res.json() as Record<string, unknown>;
    for (const key of (schema["required"] as string[] | undefined) ?? []) expect(body, operationId).toHaveProperty(key);
    for (const [key, value] of Object.entries(body)) {
      const declared = properties[key]?.type;
      expect(declared, `${operationId}: ${key} is not in the OpenAPI schema`).toBeDefined();
      const actual = Number.isInteger(value) ? "integer" : typeof value;
      expect(actual, `${operationId}: ${key}`).toBe(declared);
    }
    return;
  }
  // Inline list bodies: `{ data: [<ref>], nextCursor? }`.
  const items = properties["data"]?.items;
  const zod = items ? ZOD_FOR[ref(items)] : undefined;
  expect(zod, `${operationId}: inline schema not understood`).toBeDefined();
  const body = res.json() as { data: unknown[]; nextCursor?: unknown };
  for (const item of body.data) zod?.parse(item);
}
