import { z } from "zod";
import {
  BranchId,
  CardId,
  DisplayName,
  Expression,
  Identifier,
  Json,
  JsonSchema,
  KnowledgeBaseId,
  ModelRef,
  NonEmptyTemplate,
  TableId,
  Template,
  VariableId,
  WorkflowId,
} from "./common";
import { RowFilterTemplate, Sort } from "./table";

/* ------------------------------------------------------------------ */
/* Message templates: message payloads whose strings may hold {{ }}.   */
/* Rendered, then validated against BotMessagePayload before sending.  */
/* ------------------------------------------------------------------ */

const OptionT = z.object({ label: NonEmptyTemplate, value: NonEmptyTemplate });
const CardActionT = z.object({
  type: z.enum(["postback", "url", "say"]),
  label: NonEmptyTemplate,
  value: NonEmptyTemplate,
});
const CardBodyT = z.object({
  title: NonEmptyTemplate,
  subtitle: Template.optional(),
  imageUrl: Template.optional(),
  actions: z.array(CardActionT).max(5).default([]),
});

export const MessageTemplate = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: NonEmptyTemplate,
    format: z.enum(["markdown", "plain"]).default("markdown"),
  }),
  z.object({ type: z.literal("image"), url: NonEmptyTemplate, alt: Template.optional(), caption: Template.optional() }),
  z.object({ type: z.literal("file"), url: NonEmptyTemplate, name: NonEmptyTemplate, mime: z.string().optional() }),
  z.object({
    type: z.literal("location"),
    latitude: Expression,
    longitude: Expression,
    title: Template.optional(),
    address: Template.optional(),
  }),
  z.object({ type: z.literal("choice"), text: NonEmptyTemplate, options: z.array(OptionT).min(1).max(20) }),
  z.object({
    type: z.literal("dropdown"),
    text: NonEmptyTemplate,
    placeholder: Template.optional(),
    options: z.array(OptionT).min(1).max(100),
  }),
  CardBodyT.extend({ type: z.literal("card") }),
  z.object({ type: z.literal("carousel"), items: z.array(CardBodyT).min(1).max(10) }),
  /** `data` is an expression that must evaluate to JSON. */
  z.object({ type: z.literal("custom"), name: z.string().min(1).max(64), data: Expression }),
]);
export type MessageTemplate = z.infer<typeof MessageTemplate>;

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

const base = {
  id: CardId,
  /** Optional name shown on the canvas instead of the generated summary. */
  label: DisplayName.optional(),
  /** Disabled cards are skipped at run time and shown dimmed. */
  disabled: z.boolean().default(false),
};

/** Send a message. */
export const SayCard = z.object({ ...base, type: z.literal("say"), message: MessageTemplate });

/**
 * Ask and wait for the user's reply, validate it, store it.
 * Ports: `failed` (retries exhausted); with `routeByOption`, one port per option value: `option:<value>`.
 */
export const CaptureCard = z.object({
  ...base,
  type: z.literal("capture"),
  prompt: MessageTemplate,
  kind: z.enum(["text", "number", "boolean", "email", "phone", "date", "choice", "extract"]),
  /** Variable that receives the validated value. */
  into: VariableId,
  /** kind = extract: pull structured fields from free text with the utility model. */
  extract: z.object({ schema: JsonSchema, instructions: Template.optional() }).optional(),
  /** Extra check after type validation; must evaluate to boolean. `value` is in scope. */
  validate: z.object({ expression: Expression, message: NonEmptyTemplate }).optional(),
  maxRetries: z.number().int().min(0).max(5).default(2),
  retryMessage: Template.optional(),
  /** Skip asking when `into` already holds a valid value. */
  skipIfFilled: z.boolean().default(false),
  /** kind = choice: expose one port per option. */
  routeByOption: z.boolean().default(false),
});

/**
 * Deterministic branching. Branches are tested top to bottom; the first true one is followed.
 * Ports: `branch:<branchId>`. If none match, execution continues with the next card.
 */
export const BranchCard = z.object({
  ...base,
  type: z.literal("branch"),
  branches: z
    .array(z.object({ id: BranchId, label: DisplayName, when: Expression }))
    .min(1)
    .max(20),
});

/**
 * Model-decided branching (classification). Ports: `branch:<branchId>`; no match continues.
 */
export const AiBranchCard = z.object({
  ...base,
  type: z.literal("ai_branch"),
  input: Template.default("{{event.text}}"),
  branches: z
    .array(z.object({ id: BranchId, label: DisplayName, description: z.string().min(1).max(500) }))
    .min(1)
    .max(20),
  model: ModelRef.optional(),
});

/** Assign variables from expressions. */
export const SetVariableCard = z.object({
  ...base,
  type: z.literal("set_variable"),
  assignments: z
    .array(z.object({ variableId: VariableId, value: Expression }))
    .min(1)
    .max(20),
});

/** Run JavaScript in the sandbox. Port: `error`. */
export const CodeCard = z.object({
  ...base,
  type: z.literal("code"),
  source: z.string().max(100_000),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
});

/**
 * Search knowledge bases. Stores passages (and optionally a generated answer).
 * Port: `not_found` (no passage above the score floor).
 */
export const KbSearchCard = z.object({
  ...base,
  type: z.literal("kb_search"),
  kbIds: z.array(KnowledgeBaseId).min(1).max(20),
  query: Template.default("{{event.text}}"),
  topK: z.number().int().min(1).max(20).default(5),
  /** Receives `{ passages: Passage[] }`. */
  into: VariableId.optional(),
  answer: z
    .object({
      instructions: Template.optional(),
      /** Receives `{ text, citations }`. */
      into: VariableId,
      /** Also send the answer to the user. */
      send: z.boolean().default(false),
      model: ModelRef.optional(),
    })
    .optional(),
});

/** Table operation. Port: `not_found` for find/get with no rows. */
export const TableCard = z.object({
  ...base,
  type: z.literal("table"),
  tableId: TableId,
  operation: z.enum(["find", "get", "insert", "update", "upsert", "delete"]),
  where: RowFilterTemplate.optional(),
  search: Template.optional(),
  sort: z.array(Sort).max(3).default([]),
  limit: z.number().int().min(1).max(500).default(10),
  /** Column name → expression. insert, update, upsert. */
  values: z.record(Identifier, Expression).optional(),
  /** upsert: column that identifies the row. */
  upsertOn: Identifier.optional(),
  into: VariableId.optional(),
});

/** Call a sub-workflow like a function. */
export const CallWorkflowCard = z.object({
  ...base,
  type: z.literal("call_workflow"),
  workflowId: WorkflowId,
  /** Workflow input name → expression. */
  inputs: z.record(Identifier, Expression).default({}),
  /** Workflow output name → variable that receives it. */
  outputs: z.record(Identifier, VariableId).default({}),
});

/** Generate text with a model. */
export const AiGenerateCard = z.object({
  ...base,
  type: z.literal("ai_generate"),
  instructions: NonEmptyTemplate,
  input: Template.optional(),
  into: VariableId,
  send: z.boolean().default(false),
  model: ModelRef.optional(),
  maxOutputTokens: z.number().int().min(16).max(8_000).default(800),
});

/** Extract structured data from text with a model. */
export const AiExtractCard = z.object({
  ...base,
  type: z.literal("ai_extract"),
  input: Template.default("{{event.text}}"),
  schema: JsonSchema,
  instructions: Template.optional(),
  into: VariableId,
  model: ModelRef.optional(),
});

/** Hand the conversation to a human through the bridge. The bot stays silent until released. */
export const HandoffCard = z.object({
  ...base,
  type: z.literal("handoff"),
  reason: Template.default(""),
  /** auto: summarise the transcript with the utility model. */
  summary: z.enum(["auto", "none"]).default("auto"),
  /** Variables included in the handoff event. */
  include: z.array(VariableId).max(30).default([]),
  /** Sent to the user before handing off. */
  message: MessageTemplate.optional(),
});

/** End the conversation: clears conversation state; user variables are kept. */
export const EndCard = z.object({ ...base, type: z.literal("end"), reason: Template.default("completed") });

/** Change the inactivity timeout for this conversation. 0 = never expire. */
export const SetTimeoutCard = z.object({
  ...base,
  type: z.literal("set_timeout"),
  minutes: z.number().int().min(0).max(43_200),
});

/** Write a line to the conversation log and trace. */
export const LogCard = z.object({
  ...base,
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]).default("info"),
  message: NonEmptyTemplate,
  data: Expression.optional(),
});

export const Card = z.discriminatedUnion("type", [
  SayCard,
  CaptureCard,
  BranchCard,
  AiBranchCard,
  SetVariableCard,
  CodeCard,
  KbSearchCard,
  TableCard,
  CallWorkflowCard,
  AiGenerateCard,
  AiExtractCard,
  HandoffCard,
  EndCard,
  SetTimeoutCard,
  LogCard,
]);
export type Card = z.infer<typeof Card>;
export type CardType = Card["type"];

/** Cards required for the MVP release. The rest ship in the phase noted in the build plan. */
export const MVP_CARD_TYPES: readonly CardType[] = [
  "say",
  "capture",
  "branch",
  "set_variable",
  "code",
  "kb_search",
  "table",
  "call_workflow",
  "handoff",
  "end",
  "log",
];

/**
 * Output ports a card exposes, in display order. Port ids on edges are
 * `card:<cardId>:<key>`. A card with no ports only falls through to the next card.
 */
export function cardPortKeys(card: Card): string[] {
  switch (card.type) {
    case "capture": {
      const keys = ["failed"];
      if (card.routeByOption && card.prompt.type === "choice") {
        for (const o of card.prompt.options) keys.push(`option:${o.value}`);
      }
      return keys;
    }
    case "branch":
    case "ai_branch":
      return card.branches.map((b) => `branch:${b.id}`);
    case "code":
      return ["error"];
    case "kb_search":
      return ["not_found"];
    case "table":
      return card.operation === "find" || card.operation === "get" ? ["not_found"] : [];
    default:
      return [];
  }
}

/** Cards that stop the node: nothing after them in the same node can run. */
export const TERMINAL_CARD_TYPES: readonly CardType[] = ["handoff", "end"];

/** A retrieved passage as stored by kb_search and returned by `kb.search`. */
export const Passage = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  title: z.string(),
  uri: z.string().optional(),
  headingPath: z.array(z.string()),
  text: z.string(),
  score: z.number(),
  /** Token to place in a reply to cite this passage, e.g. `[[c1]]`. */
  cite: z.string(),
  meta: z.record(z.string(), Json).default({}),
});
export type Passage = z.infer<typeof Passage>;
