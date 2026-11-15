import { z } from "zod";
import { Card } from "./card";
import {
  DisplayName,
  ExitId,
  Expression,
  Identifier,
  JsonSchema,
  KnowledgeBaseId,
  ModelRef,
  NodeId,
  TableId,
  Template,
  ToolId,
  WorkflowId,
} from "./common";
import { TableOperation } from "./table";
import { VariableAccess } from "./variable";

/* ------------------------------------------------------------------ */
/* Tools available to an Autonomous Node. Nothing is implicit.         */
/* ------------------------------------------------------------------ */

const toolBase = {
  id: ToolId,
  /** Function name the model calls. Unique within the node. Use a verb: `createTicket`. */
  name: Identifier,
  /** Shown to the model as the doc comment. Say when to use it and when not to. */
  description: z.string().min(1).max(1_000),
};

export const CodeTool = z.object({
  ...toolBase,
  type: z.literal("code"),
  input: JsonSchema,
  output: JsonSchema.optional(),
  /** Body of `async (input, ctx) => { ... }`. Runs in the sandbox with the Execute Code API. */
  source: z.string().max(100_000),
  /** True if it changes anything outside the conversation. Never retried automatically. */
  sideEffects: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
});

export const KbSearchTool = z.object({
  ...toolBase,
  type: z.literal("kb_search"),
  kbIds: z.array(KnowledgeBaseId).min(1).max(20),
  topK: z.number().int().min(1).max(20).default(5),
});

export const TableTool = z.object({
  ...toolBase,
  type: z.literal("table"),
  tableId: TableId,
  /** Each allowed operation becomes a method: `orders.find(...)`. */
  operations: z.array(TableOperation).min(1),
});

/** A sub-workflow exposed as a function; its declared inputs and outputs are the signature. */
export const WorkflowTool = z.object({
  ...toolBase,
  type: z.literal("workflow"),
  workflowId: WorkflowId,
});

export const Tool = z.discriminatedUnion("type", [CodeTool, KbSearchTool, TableTool, WorkflowTool]);
export type Tool = z.infer<typeof Tool>;

/** A named way out of an Autonomous Node. Port id on edges: `exit:<exitId>`. */
export const Exit = z.object({
  id: ExitId,
  name: Identifier,
  /** Tells the model when to take this exit. */
  description: z.string().min(1).max(1_000),
  /** Data the model must supply; available downstream as `event.exit`. */
  schema: JsonSchema.optional(),
});
export type Exit = z.infer<typeof Exit>;

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

const nodeBase = {
  id: NodeId,
  name: DisplayName,
  description: z.string().max(500).optional(),
};

/** Entry point of the Main workflow. Exactly one. Port: `next`. */
export const StartNode = z.object({ ...nodeBase, type: z.literal("start") });

/** Entry point of a sub-workflow. Exactly one. Port: `next`. */
export const EntryNode = z.object({ ...nodeBase, type: z.literal("entry") });

/** Runs its cards top to bottom. Ports: `next`, plus card ports. */
export const StandardNode = z.object({
  ...nodeBase,
  type: z.literal("standard"),
  cards: z.array(Card).max(50).default([]),
});

/**
 * The model decides what to do using the listed tools, then leaves through an exit.
 * Ports: `exit:<exitId>` for each exit, `error`.
 * Built-in exit `listen` (wait for the user) exists only when `conversational` is true and has no port.
 */
export const AutonomousNode = z.object({
  ...nodeBase,
  type: z.literal("autonomous"),
  instructions: Template,
  model: ModelRef.optional(),
  tools: z.array(Tool).max(40).default([]),
  variableAccess: z.array(VariableAccess).max(60).default([]),
  exits: z.array(Exit).max(20).default([]),
  /** May send messages and wait for replies. False = runs once and must leave through an exit. */
  conversational: z.boolean().default(true),
  /** Adds the built-in `handoff` exit. */
  allowHandoff: z.boolean().default(false),
  maxIterations: z.number().int().min(1).max(20).default(6),
  temperature: z.number().min(0).max(2).default(0.3),
  /** Message types the model may send. */
  messageTypes: z
    .array(z.enum(["text", "image", "file", "choice", "dropdown", "card", "carousel", "location"]))
    .min(1)
    .default(["text", "choice"]),
  /** Reply when a user writes while a suspended tool is pending. */
  busyMessage: Template.optional(),
});
export type AutonomousNode = z.infer<typeof AutonomousNode>;

/** Returns from a sub-workflow. `outputs` maps declared output names to expressions. No ports. */
export const ExitNode = z.object({
  ...nodeBase,
  type: z.literal("exit"),
  outputs: z.record(Identifier, Expression).default({}),
});

/** Ends the conversation. No ports. */
export const EndNode = z.object({ ...nodeBase, type: z.literal("end"), reason: Template.default("completed") });

/**
 * Starts a path when something other than a user message happens. Cannot be an edge target.
 * Port: `next`.
 */
export const TriggerNode = z.object({
  ...nodeBase,
  type: z.literal("trigger"),
  on: z.discriminatedUnion("kind", [
    /** A custom event sent through the Bridge API. */
    z.object({ kind: z.literal("event"), name: z.string().min(1).max(64) }),
    /** First inbound activity of a new conversation, before Start. */
    z.object({ kind: z.literal("conversation_started") }),
    /** The inactivity timeout elapsed. Main workflow only. */
    z.object({ kind: z.literal("inactivity") }),
    /** A bridge released a handoff. */
    z.object({ kind: z.literal("handoff_released") }),
  ]),
});

/** Receives control when a card in this workflow fails and has no connected `error` port. Port: `next`. */
export const ErrorHandlerNode = z.object({ ...nodeBase, type: z.literal("error_handler") });

/** Canvas annotation. Ignored by the engine. */
export const NoteNode = z.object({
  ...nodeBase,
  type: z.literal("note"),
  text: z.string().max(4_000).default(""),
});

export const Node = z.discriminatedUnion("type", [
  StartNode,
  EntryNode,
  StandardNode,
  AutonomousNode,
  ExitNode,
  EndNode,
  TriggerNode,
  ErrorHandlerNode,
  NoteNode,
]);
export type Node = z.infer<typeof Node>;
export type NodeType = Node["type"];

/** Node types that cannot be the target of an edge. */
export const NON_TARGETABLE_NODE_TYPES: readonly NodeType[] = ["start", "entry", "trigger", "error_handler", "note"];

/** Node types that have no outgoing ports. */
export const TERMINAL_NODE_TYPES: readonly NodeType[] = ["exit", "end", "note"];
