import { z } from "zod";
import type { BotManifest } from "./bot-definition";
import { Passage } from "./card";
import { EventScope } from "./event";
import { BotMessagePayload } from "./message";
import type { Column, TableSchema } from "./table";
import type { IoField, Variable } from "./variable";
import type { Workflow } from "./workflow";

/**
 * Editor typings for code (architecture §5.2, task 2.9): a `.d.ts` that declares exactly the
 * sandbox's guest globals, typed from the bot's real variables, config variables and table
 * schemas. The Studio's code editor loads it so autocomplete, hover and type checks match what the
 * code will see when it runs.
 *
 * The scope objects and their types come from the bot. The shape of the functions (`tables`,
 * `kb`, `ai`, `say`, `fetch`, `axios`) is ADR-020 (proposed), which 3.3 implements in the sandbox.
 * Pure and deterministic: the same input always gives the same text, so it can be snapshotted.
 */

export interface TypingsInput {
  manifest: BotManifest;
  /** The workflow the code runs in: its variables, inputs and outputs are `workflow.*`. */
  workflow: Workflow;
  /** Table schemas of the workspace, each becoming `tables.<name>`. None until phase 10. */
  tables?: readonly TableSchema[];
}

/** Where the typings are mounted in the editor's TypeScript service. */
export const TYPINGS_FILE_NAME = "file:///guest-api.d.ts";

/**
 * TypeScript diagnostics the editor must ignore. Code is the body of an `async` function, so a
 * top-level `return` (1108) and top-level `await` (1375, 1378) are allowed.
 */
export const CODE_BODY_IGNORED_DIAGNOSTICS: readonly number[] = [1108, 1375, 1378];

/** Generates the guest API `.d.ts` for code that runs in `input.workflow`. */
export function generateTypings(input: TypingsInput): string {
  const { manifest, workflow, tables = [] } = input;
  const byScope = (scope: Variable["scope"]) => manifest.variables.filter((v) => v.scope === scope);
  const out: string[] = [];
  out.push(
    `// Guest API for code in workflow ${quoteComment(workflow.name)} of bot ${quoteComment(manifest.name)}.`,
    "// Generated from the bot's variables, config variables and tables. Do not edit.",
    "",
    prelude().trim(),
    "",
    doc(["This workflow's variables, inputs and outputs. Cleared when the workflow returns."], ""),
    `declare const workflow: ${objectType(workflowMembers(workflow), "")};`,
    "",
    doc(["Conversation variables: kept until the conversation ends."], ""),
    `declare const conversation: ${objectType(
      byScope("conversation").map((v) => variableMember(v, false)),
      "",
    )};`,
    "",
    doc(["User variables: kept for this end user across conversations."], ""),
    `declare const user: ${objectType(
      [
        ...byScope("user").map((v) => variableMember(v, false)),
        {
          name: "attributes",
          type: "{ readonly [key: string]: Guest.Json }",
          readonly: true,
          docs: ["Data your bridge sent about the user. Read-only."],
        },
      ],
      "",
    )};`,
    "",
    doc(["Bot variables: set in the Studio, read-only while the bot runs."], ""),
    `declare const bot: ${objectType(
      byScope("bot").map((v) => variableMember(v, true)),
      "",
    )};`,
    "",
    doc(["Configuration variables. Values come from the environment the bot runs in; read-only."], ""),
    `declare const env: ${objectType(
      manifest.configVars.map((c) => ({
        name: c.key,
        type: "string",
        readonly: true,
        docs: [
          ...(c.description ? [c.description] : []),
          ...(c.secret ? ["Secret: its value is redacted from logs and traces."] : []),
        ],
      })),
      "",
    )};`,
    "",
    doc(["Tables of this workspace."], ""),
    `declare const tables: ${objectType(
      tables.map((t) => ({
        name: t.name,
        type: `Guest.Table<${rowType(t.columns, "  ")}>`,
        readonly: true,
        docs: t.description ? [t.description] : [],
      })),
      "",
    )};`,
    "",
  );
  // A union that starts on its own line leaves a space after "=" or ":"; trim every line end.
  return out.join("\n").replace(/[ \t]+$/gm, "");
}

/* ------------------------------------------------------------------ */
/* Static part: the same for every bot                                 */
/* ------------------------------------------------------------------ */

const schemaOf = (schema: z.ZodType, io: "input" | "output") =>
  z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;

/** Built on first use: it is the same for every bot, and module constants it uses load after it. */
let preludeText: string | undefined;
const prelude = (): string => {
  preludeText ??= `
declare namespace Guest {
  /** Any value that survives JSON: what variables, tables and tool results hold. */
  type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

  /** A message the bot can send. A plain string is a text message. */
  type BotMessage = ${schemaToTs(schemaOf(BotMessagePayload, "input"), "  ")};

  /** The inbound event this turn is handling. */
  type Event = ${schemaToTs(schemaOf(EventScope, "output"), "  ", true)};

  /** A passage found by \`kb.search\`. Put \`cite\` in a reply to cite it. */
  type Passage = ${schemaToTs(schemaOf(Passage, "output"), "  ", true)};

  /** Operators a column condition can use. */
  interface Operators<V> {
    eq: V;
    ne: V;
    gt: V;
    gte: V;
    lt: V;
    lte: V;
    in: V[];
    contains: string;
    startsWith: string;
    isNull: boolean;
  }

  /** One condition on a column: exactly one operator, such as \`{ eq: "shipped" }\`. */
  type Condition<V> = {
    [K in keyof Operators<V>]: { [P in K]: Operators<V>[P] } & { [P in Exclude<keyof Operators<V>, K>]?: never };
  }[keyof Operators<V>];

  /** Which rows: column conditions, combined with \`and\`, \`or\` and \`not\`. */
  type Filter<Row> =
    | { and: Filter<Row>[] }
    | { or: Filter<Row>[] }
    | { not: Filter<Row> }
    | { [K in keyof Row]?: Condition<Row[K]> };

  interface FindOptions<Row> {
    where?: Filter<Row>;
    /** Full-text search over the table's searchable columns. */
    search?: string;
    sort?: { column: keyof Row & string; direction?: "asc" | "desc" }[];
    /** 1 to 500; 10 when left out. */
    limit?: number;
  }

  /** A table's rows. Every row also has an \`id\`. */
  interface Table<Row> {
    find(options?: FindOptions<Row>): Promise<(Row & { readonly id: string })[]>;
    /** The first row that matches, or null. */
    get(where: Filter<Row>): Promise<(Row & { readonly id: string }) | null>;
    insert(values: Row): Promise<Row & { readonly id: string }>;
    /** Changes every row that matches; resolves to how many changed. */
    update(where: Filter<Row>, values: Partial<Row>): Promise<number>;
    /** Inserts, or updates the row whose \`on\` column has the same value. */
    upsert(values: Row, on: keyof Row & string): Promise<Row & { readonly id: string }>;
    /** Deletes every row that matches; resolves to how many were deleted. */
    delete(where: Filter<Row>): Promise<number>;
  }

  interface RequestInit {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
    headers?: { [name: string]: string };
    body?: string;
  }

  interface Response {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
    // The body is whatever the remote service sent; narrow it before use.
    json(): Promise<any>;
  }

  interface AxiosResponse {
    readonly status: number;
    readonly statusText: string;
    readonly headers: { readonly [name: string]: string };
    // Parsed JSON when the response is JSON, otherwise the text.
    readonly data: any;
  }

  interface AxiosConfig {
    headers?: { [name: string]: string };
    params?: { [name: string]: string | number | boolean };
  }
}

/** Sends a message to the user now. A string is sent as a text message. */
declare function say(message: string | Guest.BotMessage): Promise<void>;

/** Calls a URL through the egress proxy: 10 s timeout, 5 MB response, 5 redirects. */
declare function fetch(url: string, init?: Guest.RequestInit): Promise<Guest.Response>;

/** A small axios-shaped helper over \`fetch\`, for code moved from other platforms. */
declare const axios: {
  get(url: string, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  delete(url: string, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  post(url: string, data?: Guest.Json, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  put(url: string, data?: Guest.Json, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
  patch(url: string, data?: Guest.Json, config?: Guest.AxiosConfig): Promise<Guest.AxiosResponse>;
};

/** Knowledge bases of this workspace. */
declare const kb: {
  search(query: string, options?: { kbIds?: string[]; topK?: number }): Promise<Guest.Passage[]>;
};

/** Models, through the bot's model settings. */
declare const ai: {
  /** Generates text. Uses the bot's default model unless \`model\` is given. */
  generate(options: { instructions: string; input?: string; model?: string; maxOutputTokens?: number }): Promise<string>;
  /** Extracts data that matches \`schema\` from \`input\`. Uses the utility model unless \`model\` is given. */
  extract(options: {
    input: string;
    schema: { [keyword: string]: Guest.Json };
    instructions?: string;
    model?: string;
  }): Promise<Guest.Json>;
  /** Picks one of \`labels\` for \`input\`. Uses the utility model unless \`model\` is given. */
  classify(options: { input: string; labels: string[]; instructions?: string; model?: string }): Promise<string>;
};

/** Writes to the conversation log and the trace. Never shown to the user. */
declare const log: {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const ctx: {
  /** The same on every retry of this step: pass it to services that deduplicate requests. */
  readonly idempotencyKey: string;
};

/** The inbound event this turn is handling. */
declare const event: Guest.Event;

/** Scratch values for this turn only; cleared when the turn ends. */
declare const turn: { [key: string]: Guest.Json };
`;
  return preludeText;
};

/* ------------------------------------------------------------------ */
/* Variables and tables                                                */
/* ------------------------------------------------------------------ */

interface Member {
  name: string;
  type: string;
  readonly?: boolean;
  docs?: string[];
}

function workflowMembers(wf: Workflow): Member[] {
  const seen = new Set<string>();
  const members: Member[] = [];
  const add = (m: Member) => {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    members.push(m);
  };
  for (const io of wf.inputs) add(ioMember(io, "Input"));
  for (const io of wf.outputs) add(ioMember(io, "Output"));
  for (const v of wf.variables) add(variableMember(v, false));
  return members;
}

function ioMember(io: IoField, role: "Input" | "Output"): Member {
  const base = valueType(io.type, io.schema, undefined, MEMBER_INDENT);
  // An output is set by this workflow, so it starts empty; an optional input may be left out.
  const empty = role === "Output" || !io.required;
  return {
    name: io.name,
    type: empty ? orUndefined(base) : base,
    docs: [`${role} of this workflow.`, ...(io.description ? [io.description] : [])],
  };
}

function variableMember(v: Variable, readonly: boolean): Member {
  const base = valueType(v.type, v.schema, v.enumValues, MEMBER_INDENT);
  const docs = [
    ...(v.description ? [v.description] : []),
    ...(v.type === "date" ? ["An ISO 8601 date and time."] : []),
    ...(v.default !== undefined ? [`@default ${JSON.stringify(v.default)}`] : []),
    ...(v.sensitive ? ["Sensitive: redacted in traces and the emulator."] : []),
  ];
  return { name: v.name, type: v.default === undefined ? orUndefined(base) : base, readonly, docs };
}

/** Members of the top-level scope objects sit one level in. */
const MEMBER_INDENT = "  ";

/** The TypeScript type of a variable or input/output value, printed at `indent`. */
function valueType(
  type: Variable["type"],
  schema: unknown,
  enumValues: readonly string[] | undefined,
  indent: string,
): string {
  switch (type) {
    case "string":
    case "date":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "enum":
      return enumValues && enumValues.length > 0 ? enumValues.map((e) => JSON.stringify(e)).join(" | ") : "string";
    case "object":
      return schema ? schemaToTs(schema, indent) : "{ [key: string]: Guest.Json }";
    case "array":
      return schema ? schemaToTs(schema, indent) : "Guest.Json[]";
    case "any":
      return "Guest.Json";
  }
}

function rowType(columns: readonly Column[], indent: string): string {
  return objectType(
    columns.map((c) => {
      const base =
        c.type === "number"
          ? "number"
          : c.type === "boolean"
            ? "boolean"
            : c.type === "json"
              ? "Guest.Json"
              : c.type === "enum" && c.enumValues && c.enumValues.length > 0
                ? c.enumValues.map((e) => JSON.stringify(e)).join(" | ")
                : "string";
      return {
        name: c.name,
        type: c.required ? base : `${base} | null`,
        docs: [
          ...(c.description ? [c.description] : []),
          ...(c.type === "date" ? ["An ISO 8601 date and time."] : []),
          ...(c.unique ? ["Unique in the table."] : []),
        ],
      };
    }),
    indent,
  );
}

const orUndefined = (t: string) => (t === "Guest.Json" ? t : `${t} | undefined`);

/* ------------------------------------------------------------------ */
/* JSON Schema → TypeScript                                            */
/* ------------------------------------------------------------------ */

/**
 * The TypeScript type for a JSON schema: the builder subset (`type, properties, required, items,
 * enum, description, format` and the numeric and length limits, which have no type) plus what
 * `z.toJSONSchema` produces for the contracts (`const`, `oneOf`, `anyOf`, `additionalProperties`,
 * `$ref`). The only recursive schema in the contracts is `Json`, so every `$ref` is `Guest.Json`.
 */
export function schemaToTs(schema: unknown, indent: string, readonly = false): string {
  if (!isRecord(schema)) return "Guest.Json";
  if (typeof schema["$ref"] === "string") return "Guest.Json";
  if ("const" in schema) return JSON.stringify(schema["const"]);
  if (Array.isArray(schema["enum"])) return schema["enum"].map((e) => JSON.stringify(e)).join(" | ") || "never";
  const variants = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : schema["anyOf"];
  if (Array.isArray(variants)) {
    const parts = variants.map((v) => schemaToTs(v, `${indent}  `, readonly));
    return `\n${parts.map((p) => `${indent}  | ${p}`).join("\n")}`;
  }
  const t = schema["type"];
  if (Array.isArray(t)) return t.map((one) => schemaToTs({ ...schema, type: one }, indent, readonly)).join(" | ");
  switch (t) {
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
      const item = schema["items"] === undefined ? "Guest.Json" : schemaToTs(schema["items"], indent, readonly);
      return /^[A-Za-z.]+$/.test(item) ? `${item}[]` : `Array<${item.trim()}>`;
    }
    case "object": {
      const props = isRecord(schema["properties"]) ? schema["properties"] : undefined;
      if (!props) {
        const extra = schema["additionalProperties"];
        const value = isRecord(extra) ? schemaToTs(extra, indent, readonly) : "Guest.Json";
        return `{ ${readonly ? "readonly " : ""}[key: string]: ${value} }`;
      }
      const required = new Set(Array.isArray(schema["required"]) ? schema["required"].map(String) : []);
      return objectType(
        Object.entries(props).map(([name, sub]) => {
          const description = isRecord(sub) && typeof sub["description"] === "string" ? sub["description"] : undefined;
          return {
            name,
            type: schemaToTs(sub, `${indent}  `, readonly),
            readonly,
            optional: !required.has(name),
            docs: description ? [description] : [],
          };
        }),
        indent,
      );
    }
    default:
      return "Guest.Json";
  }
}

/* ------------------------------------------------------------------ */
/* Printing                                                            */
/* ------------------------------------------------------------------ */

function objectType(members: readonly (Member & { optional?: boolean })[], indent: string): string {
  if (members.length === 0) return "{}";
  const inner = `${indent}  `;
  const lines = members.map((m) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(m.name) ? m.name : JSON.stringify(m.name);
    const head = `${inner}${m.readonly ? "readonly " : ""}${key}${m.optional ? "?" : ""}: ${m.type};`;
    return m.docs && m.docs.length > 0 ? `${doc(m.docs, inner)}\n${head}` : head;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/** A JSDoc block. Builder text is escaped so it cannot end the comment early. */
function doc(lines: readonly string[], indent: string): string {
  const body = lines.flatMap((l) => l.split(/\r?\n/)).map((l) => l.replaceAll("*/", "*\\/"));
  if (body.length === 1) return `${indent}/** ${body[0]} */`;
  return [`${indent}/**`, ...body.map((l) => `${indent} * ${l}`.trimEnd()), `${indent} */`].join("\n");
}

/** A name inside a line comment: quoted, on one line. */
const quoteComment = (s: string) => JSON.stringify(s.replace(/[\r\n]+/g, " "));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
