import {
  BOT_MESSAGE_TYPES,
  type BotMessagePayload,
  CardMessage,
  CarouselMessage,
  ChoiceMessage,
  DropdownMessage,
  FileMessage,
  formatPath,
  ImageMessage,
  type Json,
  LocationMessage,
  TextMessage,
  validateJson,
} from "@wakeel/contracts";
import { isPlainObject, parseJson, splitWord } from "./syntax";
import type { NodeMessageType, ProtocolContext, ProtocolIssueCode, ResolvedExit } from "./types";

/**
 * Checks well-formed directives against the node: which message types it may send, which exits it
 * has and what data they take (architecture §6.2–6.3).
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; code: ProtocolIssueCode; message: string };

const fail = (code: ProtocolIssueCode, message: string): { ok: false; code: ProtocolIssueCode; message: string } => ({
  ok: false,
  code,
  message,
});

interface StrictSchema {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}

/**
 * Message schemas from the contracts, made strict so a misspelt property is reported to the model
 * instead of being dropped without a word.
 */
const SCHEMAS: Record<NodeMessageType, StrictSchema> = {
  text: TextMessage.strict(),
  image: ImageMessage.strict(),
  file: FileMessage.strict(),
  location: LocationMessage.strict(),
  choice: ChoiceMessage.strict(),
  dropdown: DropdownMessage.strict(),
  card: CardMessage.strict(),
  carousel: CarouselMessage.strict(),
};

/** Which field the body lines fill, and whether the body is required. Types not listed take no body. */
const BODY_FIELD: Partial<Record<NodeMessageType, { field: string; required: boolean }>> = {
  text: { field: "text", required: true },
  choice: { field: "text", required: true },
  dropdown: { field: "text", required: true },
  image: { field: "caption", required: false },
};

const list = (items: readonly string[]) => items.join(", ");

export interface SayHeader {
  type: NodeMessageType;
  props: Record<string, Json>;
}

/** Checks the `:::say <type> [json props]` line. */
export function checkSayHeader(ctx: ProtocolContext, args: string): Checked<SayHeader> {
  const allowed = `Allowed types: ${list(ctx.messageTypes)}.`;
  const { word: type, rest } = splitWord(args);
  if (type === "")
    return fail("say_type_missing", `:::say needs a message type, for example ":::say text". ${allowed}`);
  if (!(BOT_MESSAGE_TYPES as readonly string[]).includes(type)) {
    return fail("say_type_unknown", `"${type}" is not a message type. ${allowed}`);
  }
  if (!(ctx.messageTypes as readonly string[]).includes(type)) {
    return fail("say_type_not_allowed", `Message type "${type}" is not allowed in this node. ${allowed}`);
  }
  const nodeType = type as NodeMessageType;
  if (rest === "") return { ok: true, value: { type: nodeType, props: {} } };

  const parsed = parseJson(rest);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return fail(
      "say_props_invalid",
      `The properties after ":::say ${type}" must be one JSON object on the same line, such as {"options":[...]}.`,
    );
  }
  const props = parsed.value;
  if ("type" in props) {
    return fail("say_props_invalid", `Do not repeat "type" in the properties; it comes from ":::say ${type}".`);
  }
  const body = BODY_FIELD[nodeType];
  if (body && body.field in props) {
    return fail(
      "say_props_invalid",
      `Put the ${body.field} of a ${type} message in the lines under the directive, not in the properties.`,
    );
  }
  return { ok: true, value: { type: nodeType, props } };
}

/** Builds the message from a checked header and its body, and validates it against the contracts. */
export function checkSay(header: SayHeader, body: string): Checked<BotMessagePayload> {
  const { type, props } = header;
  const candidate: Record<string, unknown> = { ...props, type };
  const field = BODY_FIELD[type];
  if (field) {
    if (body === "" && field.required) {
      return fail("say_body_missing", `A ${type} message needs its text in the lines under the directive.`);
    }
    if (body !== "") candidate[field.field] = body;
  } else if (body !== "") {
    return fail(
      "say_body_not_allowed",
      `A ${type} message has no text body. Put all of its fields in the JSON properties on the directive line.`,
    );
  }

  const result = SCHEMAS[type].safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${formatPath(i.path) || "message"}: ${i.message}`).join("; ");
    return fail("say_invalid", `The ${type} message is not valid: ${details}.`);
  }
  // A strict member of the payload union is a valid payload.
  return { ok: true, value: result.data as BotMessagePayload };
}

/** Exit names the model may use in this node, builder exits first. */
export function exitNames(ctx: ProtocolContext): string[] {
  return [
    ...ctx.exits.map((e) => e.name),
    ...(ctx.conversational ? ["listen"] : []),
    ...(ctx.allowHandoff ? ["handoff"] : []),
  ];
}

const HANDOFF_FIELDS = ["reason", "summary"];

/**
 * Checks `:::exit <name> [json]`. Built-in exits win over a builder exit of the same name when they
 * are enabled; the data of a builder exit is validated against its schema and is `{}` when absent.
 */
export function checkExit(ctx: ProtocolContext, args: string): Checked<ResolvedExit> {
  const options = `Use one of: ${list(exitNames(ctx))}.`;
  const { word: name, rest } = splitWord(args);
  if (name === "") return fail("exit_name_missing", `:::exit needs an exit name. ${options}`);

  const builtIn =
    (name === "listen" && ctx.conversational) || (name === "handoff" && ctx.allowHandoff) ? name : undefined;
  const exit = builtIn ? undefined : ctx.exits.find((e) => e.name === name);
  if (!builtIn && !exit) return fail("exit_unknown", `There is no exit "${name}". ${options}`);

  let data: Json | undefined;
  if (rest !== "") {
    const parsed = parseJson(rest);
    if (!parsed.ok) {
      return fail("exit_data_invalid", `The data after ":::exit ${name}" must be one JSON value on the same line.`);
    }
    data = parsed.value;
  }

  if (builtIn === "listen") {
    if (data !== undefined) return fail("exit_data_invalid", `The listen exit takes no data. Write ":::exit listen".`);
    return { ok: true, value: { kind: "listen" } };
  }

  if (builtIn === "handoff") {
    if (data === undefined) return { ok: true, value: { kind: "handoff" } };
    if (
      !isPlainObject(data) ||
      !Object.entries(data).every(([k, v]) => HANDOFF_FIELDS.includes(k) && typeof v === "string")
    ) {
      return fail(
        "exit_data_invalid",
        `The handoff exit takes an optional object with text fields "reason" and "summary", and nothing else.`,
      );
    }
    return {
      ok: true,
      value: {
        kind: "handoff",
        ...(typeof data["reason"] === "string" ? { reason: data["reason"] } : {}),
        ...(typeof data["summary"] === "string" ? { summary: data["summary"] } : {}),
      },
    };
  }

  // `exit` is set: either a built-in matched above or the lookup succeeded.
  const target = exit as NonNullable<typeof exit>;
  if (!target.schema) {
    if (data !== undefined) {
      return fail("exit_data_invalid", `The exit "${name}" takes no data. Write ":::exit ${name}".`);
    }
    return { ok: true, value: { kind: "exit", exitId: target.id, name, data: {} } };
  }
  const value = data ?? {};
  const issues = validateJson(target.schema, value);
  if (issues.length > 0) {
    const details = issues.map((i) => `${i.path || "data"}: ${i.message}`).join("; ");
    return fail("exit_data_mismatch", `The data for exit "${name}" does not match its schema: ${details}.`);
  }
  return { ok: true, value: { kind: "exit", exitId: target.id, name, data: value } };
}
