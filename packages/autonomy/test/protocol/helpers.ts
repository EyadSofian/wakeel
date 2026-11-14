import type { Exit } from "@wakeel/contracts";
import {
  type FinishReason,
  type ProtocolContext,
  type ProtocolEvent,
  type ProtocolResult,
  protocolV1,
} from "../../src/protocol/index";

export const exitId = (suffix: string): string => `exit_${suffix.padEnd(10, "0").slice(0, 10)}`;

export const EXITS: Exit[] = [
  {
    id: exitId("orderFound"),
    name: "order_found",
    description: "The order was found.",
    schema: {
      type: "object",
      properties: { orderId: { type: "string", minLength: 1 }, note: { type: "string" } },
      required: ["orderId"],
    },
  },
  { id: exitId("done"), name: "done", description: "The user has nothing else to ask." },
];

export const CTX: ProtocolContext = {
  conversational: true,
  allowHandoff: false,
  exits: EXITS,
  messageTypes: ["text", "choice"],
};

export const ALL_TYPES: ProtocolContext["messageTypes"] = [
  "text",
  "image",
  "file",
  "choice",
  "dropdown",
  "card",
  "carousel",
  "location",
];

export const lines = (...l: string[]): string => l.join("\n");

export interface Run {
  events: ProtocolEvent[];
  result: ProtocolResult;
}

/** Feeds `chunks` to a fresh v1 reader and collects everything it emitted. */
export function read(chunks: readonly string[], ctx: ProtocolContext = CTX, finish?: FinishReason): Run {
  const reader = protocolV1.createReader(ctx);
  const events: ProtocolEvent[] = [];
  for (const chunk of chunks) events.push(...reader.push(chunk));
  const end = reader.end(finish);
  events.push(...end.events);
  return { events, result: end.result };
}

/** Splits by UTF-16 code unit, so surrogate pairs (emoji) are cut in half across chunks. */
export function codeUnits(text: string): string[] {
  return Array.from({ length: text.length }, (_, i) => text.charAt(i));
}

/** Deterministic pseudo-random cuts (mulberry32), so a failing split can be reproduced. */
export function randomSplits(text: string, seed: number, count: number): string[][] {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: string[][] = [];
  for (let i = 0; i < count; i++) {
    const chunks: string[] = [];
    let at = 0;
    while (at < text.length) {
      const size = 1 + Math.floor(next() * 12);
      chunks.push(text.slice(at, at + size));
      at += size;
    }
    out.push(chunks);
  }
  return out;
}
