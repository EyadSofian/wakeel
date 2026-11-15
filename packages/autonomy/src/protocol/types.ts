import type { AutonomousNode, BotMessagePayload, Exit, Json } from "@wakeel/contracts";

/**
 * The marker that starts every directive line (architecture §6.2). Change it here and nowhere else
 * if adherence evals favour another string.
 */
export const PROTOCOL_MARK = ":::";

/** How the model stream ended, as `packages/llm` reports it. */
export type FinishReason = "stop" | "length" | "error";

/** Message types an Autonomous Node may send (04-contracts/node.ts `messageTypes`). */
export type NodeMessageType = AutonomousNode["messageTypes"][number];

/** What the protocol needs to know about the node it is reading replies for. */
export interface ProtocolContext {
  /** May message the user and wait: enables the built-in `listen` exit and plain-text recovery. */
  conversational: boolean;
  /** Enables the built-in `handoff` exit. */
  allowHandoff: boolean;
  exits: readonly Exit[];
  messageTypes: readonly NodeMessageType[];
}

/** Where the node goes when the model takes an exit. */
export type ResolvedExit =
  | { kind: "listen" }
  | { kind: "handoff"; reason?: string; summary?: string }
  /** A builder exit; `data` has been validated against the exit's schema and is `{}` when absent. */
  | { kind: "exit"; exitId: string; name: string; data: Json };

export const PROTOCOL_ISSUE_CODES = [
  "text_before_directive",
  "unknown_directive",
  "directive_not_at_line_start",
  "say_type_missing",
  "say_type_unknown",
  "say_type_not_allowed",
  "say_props_invalid",
  "say_body_missing",
  "say_body_not_allowed",
  "say_invalid",
  "say_after_run",
  "say_after_exit",
  "run_arguments",
  "run_empty",
  "run_twice",
  "run_after_exit",
  "exit_name_missing",
  "exit_unknown",
  "exit_data_invalid",
  "exit_data_mismatch",
  "exit_body",
  "exit_twice",
  "no_action",
  "no_directives",
  "empty_response",
  "incomplete",
] as const;

/** Why a reply was rejected. These are feedback to the model, not platform error codes. */
export type ProtocolIssueCode = (typeof PROTOCOL_ISSUE_CODES)[number];

/**
 * A rejected reply. `kind` is the `AutonomyMemory.feedback` kind and the `autonomy.iteration` trace
 * status it maps to.
 */
export interface ProtocolIssue {
  code: ProtocolIssueCode;
  kind: "protocol_error" | "exit_invalid";
  /** What was wrong and, where it helps, the valid options. Written for the model, in English. */
  message: string;
  /** 1-based line of the reply where the problem is; absent for whole-reply problems. */
  line?: number;
}

export type ProtocolEvent =
  /** A validated message, ready for the outbox. Sent before the rest of the reply has arrived. */
  | { type: "say"; message: BotMessagePayload; line: number }
  /** The reply is rejected. Nothing else is emitted after this. */
  | { type: "issue"; issue: ProtocolIssue };

/** Everything one reply amounted to, once the stream has ended. */
export interface ProtocolResult {
  /** Messages emitted as `say` events, in order. They were sent even when `issue` is set. */
  messages: BotMessagePayload[];
  /** The `:::run` body, for the sandbox. Absent when `issue` is set. */
  run?: { code: string; line: number };
  /** Absent when `issue` is set. With `run`, apply `afterRun` to decide. */
  exit?: ResolvedExit;
  issue?: ProtocolIssue;
  /** A plain-text reply was read as `:::say text` + `:::exit listen` (trace status `recovered`). */
  recovered: boolean;
  /** The reply contained `:::end` itself rather than being cut at the stop sequence. */
  explicitEnd: boolean;
}

/** Reads one model reply as it streams. Use once: push chunks, then end. */
export interface ResponseReader {
  push(chunk: string): ProtocolEvent[];
  /** Closes the reply. `finishReason` defaults to `"stop"`. */
  end(finishReason?: FinishReason): { events: ProtocolEvent[]; result: ProtocolResult };
}

/**
 * A response protocol for the Autonomous Node (ADR-002). v1 is the directive protocol; a native
 * tool-calling protocol would implement the same interface so the engine loop does not change.
 */
export interface AutonomyProtocol {
  readonly id: string;
  /** Stop sequences to pass to the model call. */
  readonly stopSequences: readonly string[];
  createReader(ctx: ProtocolContext): ResponseReader;
}
