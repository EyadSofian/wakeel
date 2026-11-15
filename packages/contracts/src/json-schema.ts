import { z } from "zod";
import { fill } from "./errors";

/**
 * The JSON Schema subset builders may write (tool inputs and outputs, exit data, extraction,
 * object and array variables): draft 2020-12 keywords `type, properties, required, items, enum,
 * description, minimum, maximum, minLength, maxLength, format`. Anything else is rejected at
 * publish time, so the engine, the editor typings and the model prompt only ever see this subset.
 *
 * `checkJsonSchema` validates a schema's structure. `validateJson` validates a value against a
 * schema that passed the check.
 */

export const JSON_SCHEMA_KEYWORDS = [
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "description",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "format",
] as const;

export const JSON_SCHEMA_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
export type JsonSchemaTypeName = (typeof JSON_SCHEMA_TYPES)[number];

/** Formats with a checker. Other draft 2020-12 formats are not part of the subset. */
export const JSON_SCHEMA_FORMATS = ["date-time", "date", "time", "email", "uri"] as const;
export type JsonSchemaFormat = (typeof JSON_SCHEMA_FORMATS)[number];

/** Nesting deeper than this is almost certainly a mistake and would make prompts and typings unreadable. */
export const JSON_SCHEMA_MAX_DEPTH = 8;

/** Messages for schema and value issues. The only place these sentences live. */
export const JSON_SCHEMA_ISSUES = {
  // Structure of the schema itself
  schema_not_object: "A schema must be an object",
  unsupported_keyword: '"{keyword}" is not supported; use only: {allowed}',
  invalid_type_name: '"{value}" is not a type; use one of: {allowed}',
  invalid_keyword_value: '"{keyword}" must be {expected}',
  keyword_not_applicable: '"{keyword}" applies only to {types} values',
  required_unknown_property: '"{property}" is required but not listed in properties',
  duplicate_value: '"{keyword}" lists "{value}" more than once',
  range_inverted: '"{min}" is greater than "{max}"',
  unsupported_format: 'Format "{value}" is not supported; use one of: {allowed}',
  too_deep: "The schema is nested more than {limit} levels deep",
  // Values checked against a schema
  type_mismatch: "Expected {expected}, received {received}",
  enum_mismatch: "Expected one of: {allowed}",
  required: '"{property}" is required',
  too_small: "Must be at least {limit}",
  too_big: "Must be at most {limit}",
  too_short: "Must be at least {limit} characters",
  too_long: "Must be at most {limit} characters",
  format_mismatch: "Expected a valid {format}",
} as const;
export type JsonSchemaIssueCode = keyof typeof JSON_SCHEMA_ISSUES;

export interface JsonSchemaIssue {
  code: JsonSchemaIssueCode;
  /** Dot path from the root, numeric segments for array items; "" is the root. */
  path: string;
  message: string;
}

type Params = Record<string, string | number>;

const issue = (code: JsonSchemaIssueCode, path: string, params: Params = {}): JsonSchemaIssue => ({
  code,
  path,
  message: fill(JSON_SCHEMA_ISSUES[code], params),
});

const join = (path: string, key: string | number) => (path === "" ? String(key) : `${path}.${key}`);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonNegativeInteger = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

const KEYWORD_TYPES: Partial<Record<(typeof JSON_SCHEMA_KEYWORDS)[number], readonly JsonSchemaTypeName[]>> = {
  properties: ["object"],
  required: ["object"],
  items: ["array"],
  minimum: ["number", "integer"],
  maximum: ["number", "integer"],
  minLength: ["string"],
  maxLength: ["string"],
  format: ["string"],
};

/**
 * Checks that `schema` uses only the supported subset and is internally consistent.
 * Returns an empty array when the schema is valid.
 */
export function checkJsonSchema(schema: unknown): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  checkNode(schema, "", 0, issues);
  return issues;
}

function checkNode(schema: unknown, path: string, depth: number, issues: JsonSchemaIssue[]): void {
  if (!isPlainObject(schema)) {
    issues.push(issue("schema_not_object", path));
    return;
  }
  if (depth > JSON_SCHEMA_MAX_DEPTH) {
    issues.push(issue("too_deep", path, { limit: JSON_SCHEMA_MAX_DEPTH }));
    return;
  }

  const allowed = JSON_SCHEMA_KEYWORDS as readonly string[];
  for (const keyword of Object.keys(schema)) {
    if (!allowed.includes(keyword)) {
      issues.push(issue("unsupported_keyword", join(path, keyword), { keyword, allowed: allowed.join(", ") }));
    }
  }

  const types = checkType(schema, path, issues);

  // Keywords that only make sense for some types, when the schema names its type(s).
  if (types !== undefined) {
    for (const [keyword, applies] of Object.entries(KEYWORD_TYPES)) {
      if (keyword in schema && !applies.some((t) => types.includes(t))) {
        issues.push(issue("keyword_not_applicable", join(path, keyword), { keyword, types: applies.join(" or ") }));
      }
    }
  }

  let propertyNames: string[] | undefined;
  if ("properties" in schema) {
    const properties = schema["properties"];
    if (!isPlainObject(properties)) {
      issues.push(
        issue("invalid_keyword_value", join(path, "properties"), { keyword: "properties", expected: "an object" }),
      );
    } else {
      propertyNames = Object.keys(properties);
      for (const [name, sub] of Object.entries(properties)) {
        checkNode(sub, join(join(path, "properties"), name), depth + 1, issues);
      }
    }
  }

  if ("required" in schema) {
    const required = schema["required"];
    if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) {
      issues.push(
        issue("invalid_keyword_value", join(path, "required"), { keyword: "required", expected: "a list of names" }),
      );
    } else {
      checkUnique("required", required, path, issues);
      if (propertyNames !== undefined) {
        for (const name of required) {
          if (!propertyNames.includes(name)) {
            issues.push(issue("required_unknown_property", join(path, "required"), { property: name }));
          }
        }
      }
    }
  }

  if ("items" in schema) checkNode(schema["items"], join(path, "items"), depth + 1, issues);

  if ("enum" in schema) {
    const values = schema["enum"];
    if (!Array.isArray(values) || values.length === 0) {
      issues.push(
        issue("invalid_keyword_value", join(path, "enum"), { keyword: "enum", expected: "a non-empty list" }),
      );
    } else {
      checkUnique("enum", values, path, issues);
    }
  }

  if ("description" in schema && typeof schema["description"] !== "string") {
    issues.push(
      issue("invalid_keyword_value", join(path, "description"), { keyword: "description", expected: "text" }),
    );
  }

  checkRange(schema, path, "minimum", "maximum", Number.isFinite, "a number", issues);
  checkRange(schema, path, "minLength", "maxLength", isNonNegativeInteger, "a whole number of 0 or more", issues);

  if ("format" in schema) {
    const format = schema["format"];
    if (typeof format !== "string" || !(JSON_SCHEMA_FORMATS as readonly string[]).includes(format)) {
      issues.push(
        issue("unsupported_format", join(path, "format"), {
          value: String(format),
          allowed: JSON_SCHEMA_FORMATS.join(", "),
        }),
      );
    }
  }
}

/** Returns the declared type names, or undefined when the schema has no valid `type`. */
function checkType(
  schema: Record<string, unknown>,
  path: string,
  issues: JsonSchemaIssue[],
): JsonSchemaTypeName[] | undefined {
  if (!("type" in schema)) return undefined;
  const raw = schema["type"];
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    issues.push(issue("invalid_keyword_value", join(path, "type"), { keyword: "type", expected: "a type name" }));
    return undefined;
  }
  const known = JSON_SCHEMA_TYPES as readonly unknown[];
  let ok = true;
  for (const t of list) {
    if (!known.includes(t)) {
      ok = false;
      issues.push(
        issue("invalid_type_name", join(path, "type"), { value: String(t), allowed: JSON_SCHEMA_TYPES.join(", ") }),
      );
    }
  }
  if (Array.isArray(raw)) checkUnique("type", raw, path, issues);
  return ok ? (list as JsonSchemaTypeName[]) : undefined;
}

function checkUnique(keyword: string, values: unknown[], path: string, issues: JsonSchemaIssue[]): void {
  const seen = new Set<string>();
  for (const v of values) {
    const key = stableStringify(v);
    if (seen.has(key)) issues.push(issue("duplicate_value", join(path, keyword), { keyword, value: key }));
    seen.add(key);
  }
}

function checkRange(
  schema: Record<string, unknown>,
  path: string,
  minKey: string,
  maxKey: string,
  valid: (v: unknown) => boolean,
  expected: string,
  issues: JsonSchemaIssue[],
): void {
  let bothValid = true;
  for (const key of [minKey, maxKey]) {
    if (key in schema && !valid(schema[key])) {
      bothValid = false;
      issues.push(issue("invalid_keyword_value", join(path, key), { keyword: key, expected }));
    }
  }
  const min = schema[minKey];
  const max = schema[maxKey];
  if (bothValid && typeof min === "number" && typeof max === "number" && min > max) {
    issues.push(issue("range_inverted", path, { min: minKey, max: maxKey }));
  }
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

const FORMAT_CHECKS: Record<JsonSchemaFormat, z.ZodType> = {
  "date-time": z.iso.datetime({ offset: true }),
  date: z.iso.date(),
  time: z.iso.time(),
  email: z.email(),
  uri: z.url(),
};

/**
 * Validates `value` against a schema that passed `checkJsonSchema`. Properties not listed in
 * `properties` are allowed, as in JSON Schema. String lengths count Unicode code points, so an
 * Arabic letter with a combining mark counts as two, and an emoji as one.
 */
export function validateJson(schema: Record<string, unknown>, value: unknown): JsonSchemaIssue[] {
  const issues: JsonSchemaIssue[] = [];
  validateNode(schema, value, "", issues);
  return issues;
}

function validateNode(schema: Record<string, unknown>, value: unknown, path: string, issues: JsonSchemaIssue[]): void {
  const declared = schema["type"];
  if (declared !== undefined) {
    const types = (Array.isArray(declared) ? declared : [declared]) as JsonSchemaTypeName[];
    if (!types.some((t) => matchesType(t, value))) {
      issues.push(issue("type_mismatch", path, { expected: types.join(" or "), received: describe(value) }));
      return;
    }
  }

  const allowed = schema["enum"];
  if (Array.isArray(allowed)) {
    const key = stableStringify(value);
    if (!allowed.some((a) => stableStringify(a) === key)) {
      issues.push(issue("enum_mismatch", path, { allowed: allowed.map((a) => stableStringify(a)).join(", ") }));
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    const min = schema["minLength"];
    const max = schema["maxLength"];
    if (typeof min === "number" && length < min) issues.push(issue("too_short", path, { limit: min }));
    if (typeof max === "number" && length > max) issues.push(issue("too_long", path, { limit: max }));
    const format = schema["format"];
    if (typeof format === "string" && format in FORMAT_CHECKS) {
      if (!FORMAT_CHECKS[format as JsonSchemaFormat].safeParse(value).success) {
        issues.push(issue("format_mismatch", path, { format }));
      }
    }
  }

  if (typeof value === "number") {
    const min = schema["minimum"];
    const max = schema["maximum"];
    if (typeof min === "number" && value < min) issues.push(issue("too_small", path, { limit: min }));
    if (typeof max === "number" && value > max) issues.push(issue("too_big", path, { limit: max }));
  }

  if (isPlainObject(value)) {
    const required = schema["required"];
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === "string" && !(name in value)) {
          issues.push(issue("required", join(path, name), { property: name }));
        }
      }
    }
    const properties = schema["properties"];
    if (isPlainObject(properties)) {
      for (const [name, sub] of Object.entries(properties)) {
        if (name in value && isPlainObject(sub)) validateNode(sub, value[name], join(path, name), issues);
      }
    }
  }

  if (Array.isArray(value)) {
    const items = schema["items"];
    if (isPlainObject(items)) {
      for (const [i, item] of value.entries()) validateNode(items, item, join(path, i), issues);
    }
  }
}

function matchesType(type: JsonSchemaTypeName, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

/** JSON text with object keys sorted, so equal values compare equal regardless of key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
