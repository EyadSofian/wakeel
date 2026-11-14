import type { AutonomousNode, BotMessagePayload } from "@wakeel/contracts";
import { issueKind } from "./outcome";
import { bodyText, classifyLine, type Keyword, startsDirective } from "./syntax";
import {
  type AutonomyProtocol,
  type FinishReason,
  PROTOCOL_MARK,
  type ProtocolContext,
  type ProtocolEvent,
  type ProtocolIssue,
  type ProtocolIssueCode,
  type ProtocolResult,
  type ResolvedExit,
  type ResponseReader,
} from "./types";
import { type Checked, checkExit, checkSay, checkSayHeader, type SayHeader } from "./validator";

type Block =
  | { kind: "say"; line: number; header: SayHeader; body: string[] }
  | { kind: "run"; line: number; body: string[] }
  | { kind: "exit"; line: number };

/**
 * Reads one reply in turn protocol v1 (architecture §6.2). Lines are handled as they complete; a
 * `:::say` is validated and emitted as soon as the next directive starts, so the user sees it while
 * the model is still writing. The first problem stops the reader: nothing after it is emitted, and
 * the reply neither runs code nor takes an exit.
 */
class V1Reader implements ResponseReader {
  private readonly ctx: ProtocolContext;
  /** The current, incomplete line. */
  private partial = "";
  private lineNo = 0;
  private block: Block | undefined;
  /** Lines before the first directive: blank, or the whole reply when it has no directives. */
  private readonly preamble: { line: number; text: string }[] = [];
  private seenDirective = false;
  private readonly messages: BotMessagePayload[] = [];
  private run: { code: string; line: number } | undefined;
  private exit: ResolvedExit | undefined;
  private issue: ProtocolIssue | undefined;
  private explicitEnd = false;
  private recovered = false;
  private closed = false;
  private events: ProtocolEvent[] = [];

  constructor(ctx: ProtocolContext) {
    this.ctx = ctx;
  }

  push(chunk: string): ProtocolEvent[] {
    if (this.closed) throw new Error("The reply reader has ended; create a new one for the next reply.");
    if (this.done()) return [];
    this.partial += chunk;
    let newline = this.partial.indexOf("\n");
    while (newline !== -1 && !this.done()) {
      const line = this.partial.slice(0, newline);
      this.partial = this.partial.slice(newline + 1);
      this.onLine(line);
      newline = this.partial.indexOf("\n");
    }
    if (this.done()) this.partial = "";
    else if (this.block?.kind === "say" && startsDirective(this.partial)) this.closeBlock();
    return this.take();
  }

  end(finishReason: FinishReason = "stop"): { events: ProtocolEvent[]; result: ProtocolResult } {
    if (this.closed) throw new Error("The reply reader has already ended.");
    this.closed = true;
    if (!this.done() && this.partial !== "") this.onLine(this.partial);
    this.partial = "";
    if (!this.issue) this.finish(finishReason);
    return { events: this.take(), result: this.result() };
  }

  private finish(finishReason: FinishReason): void {
    if (!this.explicitEnd && finishReason !== "stop") {
      this.reject("incomplete", "The reply was cut off before it finished. Write a shorter reply.");
      return;
    }
    if (!this.seenDirective) {
      this.recover();
      return;
    }
    this.closeBlock();
    if (this.issue) return;
    if (!this.run && !this.exit) {
      this.reject(
        "no_action",
        "The reply sent messages but neither ran code nor took an exit. End every reply with :::run or :::exit.",
      );
    }
  }

  /** Architecture §6.2 recovery: a reply with no directives. */
  private recover(): void {
    const text = bodyText(this.preamble.map((p) => p.text));
    if (text === "") {
      this.reject("empty_response", "The reply was empty. Reply with directives, for example :::say text.");
      return;
    }
    if (!this.ctx.conversational) {
      this.reject(
        "no_directives",
        "The reply had no directives. Write every reply as directives and leave through one of the exits.",
      );
      return;
    }
    const message = checkSay({ type: "text", props: {} }, text);
    const ok = this.accept(message, 1);
    if (!ok) return;
    this.messages.push(message.value);
    this.events.push({ type: "say", message: message.value, line: 1 });
    this.exit = { kind: "listen" };
    this.recovered = true;
  }

  private onLine(raw: string): void {
    this.lineNo++;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const kind = classifyLine(line);
    switch (kind.kind) {
      case "directive":
        this.onDirective(kind.keyword, kind.args);
        return;
      case "unknown_directive":
        this.reject(
          "unknown_directive",
          `"${[...line].slice(0, 40).join("")}" is not a directive. A line that starts with ${PROTOCOL_MARK} must be :::say, :::run, :::exit or :::end.`,
          this.lineNo,
        );
        return;
      case "misplaced_directive":
        this.reject(
          "directive_not_at_line_start",
          "A directive must start at the very beginning of its line, with nothing before the marker.",
          this.lineNo,
        );
        return;
      case "text":
        this.onText(line);
        return;
    }
  }

  private onText(line: string): void {
    const block = this.block;
    if (!block) {
      this.preamble.push({ line: this.lineNo, text: line });
      return;
    }
    if (block.kind !== "exit") {
      block.body.push(line);
      return;
    }
    if (line.trim() !== "") {
      this.reject(
        "exit_body",
        "Exit data goes on the same line as :::exit, as one JSON value. Only :::end may follow an exit.",
        this.lineNo,
      );
    }
  }

  private onDirective(keyword: Keyword, args: string): void {
    if (keyword === "end") {
      // `:::end` alone does not count as a directive for recovery: it is the stop sequence, so most
      // providers never show it, and a plain reply should not be treated differently when one does.
      if (this.seenDirective) this.closeBlock();
      this.explicitEnd = true;
      return;
    }
    if (!this.seenDirective) {
      const stray = this.preamble.find((p) => p.text.trim() !== "");
      if (stray) {
        this.reject(
          "text_before_directive",
          "Text appeared before the first directive. Start the reply with a directive line such as :::say text.",
          stray.line,
        );
        return;
      }
      this.seenDirective = true;
    }
    this.closeBlock();
    if (this.done()) return;
    const line = this.lineNo;
    const misplaced = this.orderIssue(keyword, args);
    if (misplaced) {
      this.reject(misplaced[0], misplaced[1], line);
      return;
    }

    if (keyword === "say") {
      const header = checkSayHeader(this.ctx, args);
      if (this.accept(header, line)) this.block = { kind: "say", line, header: header.value, body: [] };
    } else if (keyword === "run") {
      this.block = { kind: "run", line, body: [] };
    } else {
      const exit = checkExit(this.ctx, args);
      if (!this.accept(exit, line)) return;
      this.exit = exit.value;
      this.block = { kind: "exit", line };
    }
  }

  /** The order rules: says, then at most one run, then at most one exit, then only `:::end`. */
  private orderIssue(keyword: Exclude<Keyword, "end">, args: string): [ProtocolIssueCode, string] | undefined {
    const afterExit = "Only :::end may follow :::exit.";
    switch (keyword) {
      case "say":
        if (this.exit) return ["say_after_exit", afterExit];
        if (this.run) return ["say_after_run", "Put every :::say before the :::run block."];
        return undefined;
      case "run":
        if (this.exit) return ["run_after_exit", afterExit];
        if (this.run) return ["run_twice", "A reply may contain only one :::run block."];
        if (args !== "")
          return ["run_arguments", ":::run takes nothing on its line. Put the code on the lines below it."];
        return undefined;
      case "exit":
        return this.exit ? ["exit_twice", "A reply may take only one exit."] : undefined;
    }
  }

  /** Ends the open block: emits a say, or keeps the run code. */
  private closeBlock(): void {
    const block = this.block;
    this.block = undefined;
    if (block?.kind === "say") {
      const message = checkSay(block.header, bodyText(block.body));
      if (!this.accept(message, block.line)) return;
      this.messages.push(message.value);
      this.events.push({ type: "say", message: message.value, line: block.line });
    } else if (block?.kind === "run") {
      const code = bodyText(block.body);
      if (code === "") this.reject("run_empty", "The :::run block has no code.", block.line);
      else this.run = { code, line: block.line };
    }
  }

  private accept<T>(checked: Checked<T>, line: number): checked is { ok: true; value: T } {
    if (!checked.ok) this.reject(checked.code, checked.message, line);
    return checked.ok;
  }

  private reject(code: ProtocolIssueCode, message: string, line?: number): void {
    this.issue = { code, kind: issueKind(code), message, ...(line === undefined ? {} : { line }) };
    this.block = undefined;
    this.events.push({ type: "issue", issue: this.issue });
  }

  private done(): boolean {
    return this.issue !== undefined || this.explicitEnd;
  }

  private take(): ProtocolEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private result(): ProtocolResult {
    const base = { messages: [...this.messages], recovered: this.recovered, explicitEnd: this.explicitEnd };
    if (this.issue) return { ...base, issue: this.issue };
    return {
      ...base,
      ...(this.run ? { run: this.run } : {}),
      ...(this.exit ? { exit: this.exit } : {}),
    };
  }
}

/** Turn protocol v1: line directives `:::say`, `:::run`, `:::exit`, `:::end` (architecture §6.2). */
export const protocolV1: AutonomyProtocol = {
  id: "directives_v1",
  stopSequences: [`${PROTOCOL_MARK}end`],
  createReader: (ctx) => new V1Reader(ctx),
};

/** The protocol settings of an Autonomous Node. */
export function contextFromNode(node: AutonomousNode): ProtocolContext {
  return {
    conversational: node.conversational,
    allowHandoff: node.allowHandoff,
    exits: node.exits,
    messageTypes: node.messageTypes,
  };
}
