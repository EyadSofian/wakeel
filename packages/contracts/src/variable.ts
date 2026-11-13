import { z } from "zod";
import { Identifier, Json, JsonSchema, VariableId } from "./common";

/**
 * bot          read-only at run time; set in the Studio
 * user         per end user, across conversations
 * conversation per conversation, across workflows
 * workflow     per workflow invocation (frame); cleared when the workflow returns
 */
export const VariableScope = z.enum(["bot", "user", "conversation", "workflow"]);
export type VariableScope = z.infer<typeof VariableScope>;

export const VariableType = z.enum(["string", "number", "boolean", "date", "enum", "object", "array", "any"]);
export type VariableType = z.infer<typeof VariableType>;

export const Variable = z
  .object({
    id: VariableId,
    /** Referenced in code and templates as `<scope>.<name>`. Unique per scope (per workflow for workflow scope). */
    name: Identifier,
    scope: VariableScope,
    type: VariableType,
    /** Required when type is `enum`. */
    enumValues: z.array(z.string().min(1)).min(1).max(100).optional(),
    /** Shape for `object` and `array`; drives editor typings and runtime validation. */
    schema: JsonSchema.optional(),
    default: Json.optional(),
    description: z.string().max(500).optional(),
    /** Sensitive values are redacted in traces and never shown in the emulator variable panel. */
    sensitive: z.boolean().default(false),
  })
  .refine((v) => v.type !== "enum" || (v.enumValues?.length ?? 0) > 0, {
    path: ["enumValues"],
    message: "Add at least one allowed value",
  });
export type Variable = z.infer<typeof Variable>;

/** Configuration variable declared on the bot; values live encrypted in `bot_config_vars`, read as `env.<KEY>`. */
export const ConfigVar = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use upper-case letters, digits and underscores"),
  secret: z.boolean().default(true),
  description: z.string().max(500).optional(),
});
export type ConfigVar = z.infer<typeof ConfigVar>;

/** Input or output of a workflow. */
export const IoField = z.object({
  name: Identifier,
  type: VariableType,
  schema: JsonSchema.optional(),
  required: z.boolean().default(true),
  description: z.string().max(500).optional(),
});
export type IoField = z.infer<typeof IoField>;

/** Access an Autonomous Node has to one variable. Nothing is readable or writable unless listed. */
export const VariableAccess = z.object({
  variableId: VariableId,
  mode: z.enum(["read", "write"]),
});
export type VariableAccess = z.infer<typeof VariableAccess>;

/** Read-only objects present in every expression and code scope, besides the four variable scopes. */
export const BUILT_IN_SCOPES = ["event", "env", "turn"] as const;
