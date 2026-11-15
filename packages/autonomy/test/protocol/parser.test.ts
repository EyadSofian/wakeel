import { chunkText, everySplit } from "@wakeel/testing";
import { describe, expect, test } from "vitest";
import { PROTOCOL_MARK, type ProtocolEvent, protocolV1 } from "../../src/protocol/index";
import { CASES, type ParserCase } from "./cases";
import { CTX, codeUnits, lines, randomSplits, read } from "./helpers";

const ctxOf = (c: ParserCase) => ({ ...CTX, ...c.ctx });

describe("turn protocol v1 cases", () => {
  test("the plan's minimum of 60 cases is met", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  test.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { events, result } = read([c.input], ctxOf(c), c.finish);

    expect(result.messages).toEqual(c.says ?? []);
    expect(events.filter((e) => e.type === "say").map((e) => e.message)).toEqual(c.says ?? []);
    expect(result.issue?.code).toBe(c.issue);
    if (c.issueLine !== undefined) expect(result.issue?.line).toBe(c.issueLine);
    expect(result.recovered).toBe(c.recovered ?? false);

    if (c.issue) {
      // A reply with a protocol error neither runs code nor leaves the node.
      expect(result.run).toBeUndefined();
      expect(result.exit).toBeUndefined();
      expect(events.filter((e) => e.type === "issue")).toHaveLength(1);
      expect(result.issue?.message.length).toBeGreaterThan(0);
    } else {
      expect(result.run?.code).toBe(c.run);
      expect(result.exit).toEqual(c.exit);
      expect(events.some((e) => e.type === "issue")).toBe(false);
    }
  });

  test.each(CASES.map((c) => [c.name, c] as const))("same outcome at every chunk boundary: %s", (_name, c) => {
    const ctx = ctxOf(c);
    const whole = read([c.input], ctx, c.finish);
    const chunkings: string[][] = [
      chunkText(c.input, 1),
      chunkText(c.input, 3),
      codeUnits(c.input),
      ...randomSplits(c.input, 7, 5),
    ];
    // Exhaustive two-chunk splits, except for the one very long case where sampling is enough.
    if (c.input.length < 1_000) chunkings.push(...everySplit(c.input));
    for (const chunks of chunkings) {
      const split = read(chunks, ctx, c.finish);
      expect(split.result).toEqual(whole.result);
      expect(split.events).toEqual(whole.events);
    }
  });
});

describe("streaming", () => {
  const sayEvents = (events: ProtocolEvent[]) => events.filter((e) => e.type === "say");

  test("a say is sent as soon as the next directive starts, before that line is complete", () => {
    const reader = protocolV1.createReader(CTX);
    expect(reader.push(":::say text\nFirst\n")).toEqual([]);
    expect(reader.push(":::sa")).toEqual([]);
    const events = reader.push("y ");
    expect(sayEvents(events)).toEqual([
      { type: "say", line: 1, message: { type: "text", text: "First", format: "markdown" } },
    ]);
    expect(reader.push('choice {"options":[{"label":"A","value":"a"}]}\nPick\n')).toEqual([]);
    expect(sayEvents(reader.push(":::exit listen\n"))).toHaveLength(1);
    expect(reader.end().events).toEqual([]);
  });

  test("a say is not sent while its body may still grow", () => {
    const reader = protocolV1.createReader(CTX);
    expect(reader.push(":::say text\nHel")).toEqual([]);
    expect(reader.push("lo\n")).toEqual([]);
    expect(reader.push("more text\n")).toEqual([]);
    const end = reader.end();
    expect(sayEvents(end.events)).toHaveLength(1);
    // Says only, so the reply still needs an action.
    expect(end.result.issue?.code).toBe("no_action");
  });

  test("an ambiguous partial marker does not close the say", () => {
    const reader = protocolV1.createReader(CTX);
    reader.push(":::say text\nHi\n");
    // `:::end` could still become `:::ending`, and `:::ru` could be anything.
    expect(reader.push(":::end")).toEqual([]);
    expect(reader.push("ing\n")).toEqual([
      { type: "issue", issue: expect.objectContaining({ code: "unknown_directive" }) },
    ]);
  });

  test(":::end without a newline at the end of the stream closes the reply", () => {
    const reader = protocolV1.createReader(CTX);
    reader.push(":::say text\nHi\n:::exit listen\n:::en");
    const end = reader.push("d");
    expect(end).toEqual([]);
    const { result } = reader.end();
    expect(result.explicitEnd).toBe(true);
    expect(result.exit).toEqual({ kind: "listen" });
  });

  test("the run block is only reported once the stream ends", () => {
    const reader = protocolV1.createReader(CTX);
    expect(reader.push(":::run\nreturn 1\n")).toEqual([]);
    expect(reader.end().result.run).toEqual({ code: "return 1", line: 1 });
  });

  test("nothing is emitted after the first issue", () => {
    const reader = protocolV1.createReader(CTX);
    const first = reader.push(lines(":::say text", "Hi", ":::run", "return 1", ":::run", ""));
    expect(first.map((e) => e.type)).toEqual(["say", "issue"]);
    expect(reader.push(":::say text\nMore\n:::exit listen\n")).toEqual([]);
    expect(reader.end().events).toEqual([]);
  });

  test("text after :::end is ignored even when it arrives in later chunks", () => {
    const reader = protocolV1.createReader(CTX);
    reader.push(":::exit listen\n:::end\n");
    expect(reader.push(":::say text\nIgnored\n")).toEqual([]);
    const { result } = reader.end("length");
    expect(result.issue).toBeUndefined();
    expect(result.messages).toEqual([]);
  });

  test("a reader cannot be used after it ended", () => {
    const reader = protocolV1.createReader(CTX);
    reader.end();
    expect(() => reader.push("x")).toThrow();
    expect(() => reader.end()).toThrow();
  });

  test("the recovered say is emitted when the stream ends", () => {
    const reader = protocolV1.createReader(CTX);
    expect(reader.push("Hello ")).toEqual([]);
    expect(reader.push("there")).toEqual([]);
    const { events, result } = reader.end();
    expect(events).toEqual([
      { type: "say", line: 1, message: { type: "text", text: "Hello there", format: "markdown" } },
    ]);
    expect(result.recovered).toBe(true);
  });

  test("issue events carry the issue and its line", () => {
    const { events } = read([lines(":::say text", "Hi", ":::exit nowhere")]);
    expect(events).toEqual([
      { type: "say", line: 1, message: { type: "text", text: "Hi", format: "markdown" } },
      { type: "issue", issue: expect.objectContaining({ code: "exit_unknown", kind: "exit_invalid", line: 3 }) },
    ]);
  });
});

describe("protocol v1 constants", () => {
  test("the marker is defined once and the stop sequence is derived from it", () => {
    expect(PROTOCOL_MARK).toBe(":::");
    expect(protocolV1.stopSequences).toEqual([`${PROTOCOL_MARK}end`]);
    expect(protocolV1.id).toBe("directives_v1");
  });
});
