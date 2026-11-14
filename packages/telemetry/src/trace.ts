import { createHash } from "node:crypto";
import {
  type BotDefinition,
  type ConversationState,
  INLINE_PAYLOAD_BYTES,
  idFromDigest,
  type Json,
  type Payload,
  type Span,
  type Variable,
} from "@wakeel/contracts";

/**
 * The minimal trace writer (task 4.7, architecture §12, ADR-009, ADR-026). The turn worker feeds
 * this builder its step commits; it returns the spans to upsert. It is pure: no I/O, no clock of
 * its own, so the worker decides when to write and a failed write never touches the turn.
 *
 * Spans: `turn` (seq 0, the root), one `node` span per stretch of steps in a node, one `card` span
 * per card step, a `code.exec` span under each code card, and an `error` span per failure. Turn and
 * node spans are returned when they open and again, complete, when they close, so a live list can
 * show a row as soon as it starts.
 */

/** What the builder needs from a step commit; the engine's `StepCommit` fits it as is. */
export interface TraceStep {
  stepSeq: number;
  state: ConversationState;
  failures: readonly {
    code: string;
    message: string;
    fix: string;
    location: { workflowId: string; nodeId: string; cardId?: string };
    handledBy: string;
  }[];
  logs: readonly { level: string; message: string; data?: Json }[];
  step?: { workflowId: string; nodeId: string; cardId?: string; outcome: string };
}

export interface TraceContext {
  workspaceId: string;
  botId: string;
  conversationId: string;
  turnId: string;
  mode: "live" | "emulator" | "eval";
  trigger: Extract<Span, { kind: "turn" }>["attrs"]["trigger"];
  versionId?: string | null | undefined;
}

/** The end user's values before a step, for the variable diff. */
export interface TraceBefore {
  state: ConversationState;
  user: { vars: Record<string, Json>; attributes: Record<string, Json> };
}

const REDACTED = "[redacted]";
const PREVIEW_CHARS = 400;
const encoder = new TextEncoder();

/**
 * A payload as stored for now: inline up to `INLINE_PAYLOAD_BYTES`, otherwise a preview and the
 * true size with an empty key. The object store (ADR-009) arrives with the first large producer.
 */
export function inlinePayload(value: Json): Payload {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = encoder.encode(text).length;
  if (bytes <= INLINE_PAYLOAD_BYTES) return { inline: true, value };
  return { inline: false, key: "", bytes, preview: Array.from(text).slice(0, PREVIEW_CHARS).join("") };
}

/** `span_` + a hash of the turn and the span's seq (ADR-026). */
export function spanId(turnId: string, seq: number): Span["id"] {
  return idFromDigest("span", createHash("sha256").update(`${turnId}:${seq}`).digest()) as Span["id"];
}

type NodeSpan = Extract<Span, { kind: "node" }>;
type TurnSpan = Extract<Span, { kind: "turn" }>;

export class TraceBuilder {
  readonly #ctx: TraceContext;
  readonly #definition: BotDefinition;
  #seq = 0;
  #turn: TurnSpan | undefined;
  #node: NodeSpan | undefined;
  /** The last outcome in the open node, which becomes its `leftBy` when it closes. */
  #lastOutcome: string | undefined;
  /** End of the previous step: where the next card span starts. */
  #boundary: Date | undefined;

  constructor(ctx: TraceContext, definition: BotDefinition, existing: readonly Span[] = []) {
    this.#ctx = ctx;
    this.#definition = definition;
    if (existing.length > 0) this.#resume(existing);
  }

  /** The root span's id: failures outside any step hang under it. */
  get turnSpanId(): Span["id"] {
    return spanId(this.#ctx.turnId, 0);
  }

  /** The turn span, open. Empty on a resumed turn, whose turn span is already stored. */
  turnStarted(at: Date): Span[] {
    if (this.#turn) return [];
    this.#turn = {
      ...this.#base(0, "Turn", at),
      kind: "turn",
      attrs: {
        trigger: this.#ctx.trigger,
        mode: this.#ctx.mode,
        ...(this.#ctx.versionId ? { versionId: this.#ctx.versionId } : {}),
      },
    };
    this.#seq = Math.max(this.#seq, 1);
    this.#boundary = at;
    return [this.#turn];
  }

  /** The spans for one committed step; `before` is the state before it, for the variable diff. */
  stepCommitted(step: TraceStep, before: TraceBefore, at: Date): Span[] {
    const start = this.#boundary ?? at;
    this.#boundary = at;
    const out: Span[] = [];
    let parent: Span["id"] = this.turnSpanId;

    if (step.step) {
      const { workflowId, nodeId, cardId, outcome } = step.step;
      if (!this.#node || this.#node.location.nodeId !== nodeId || this.#node.location.workflowId !== workflowId) {
        if (this.#node) out.push(this.#closeNode(start));
        const node = this.#definition.workflows.find((w) => w.id === workflowId)?.nodes.find((n) => n.id === nodeId);
        this.#node = {
          ...this.#base(this.#seq++, node?.name ?? nodeId, start),
          parentId: this.turnSpanId,
          location: { workflowId, nodeId },
          kind: "node",
          attrs: { nodeType: node?.type ?? "unknown" },
        };
        out.push(this.#node);
      }
      this.#lastOutcome = outcome;
      parent = this.#node.id;

      if (cardId) {
        const card = this.#card(workflowId, nodeId, cardId);
        const failed = step.failures.some((f) => f.location.cardId === cardId);
        const writes = this.#writes(before, step, workflowId);
        const cardSpan: Span = {
          ...this.#base(this.#seq++, card?.type ?? "card", start, at),
          parentId: this.#node.id,
          status: failed ? "error" : "ok",
          location: { workflowId, nodeId, cardId },
          kind: "card",
          attrs: { cardType: card?.type ?? "unknown", outcome, ...(writes ? { writes } : {}) },
        };
        out.push(cardSpan);
        parent = cardSpan.id;
        if (card?.type === "code") {
          out.push({
            ...this.#base(this.#seq++, "Run code", start, at),
            parentId: cardSpan.id,
            status: failed ? "error" : "ok",
            location: { workflowId, nodeId, cardId },
            kind: "code.exec",
            attrs: {
              kind: "card",
              source: inlinePayload(card.source),
              ...(step.logs.length > 0 ? { logs: inlinePayload(step.logs as unknown as Json) } : {}),
            },
          });
        }
      }
    }

    for (const f of step.failures) {
      out.push({
        ...this.#base(this.#seq++, f.code, at),
        parentId: parent,
        status: "error",
        location: { ...f.location },
        kind: "error",
        attrs: { code: f.code, message: f.message, fix: f.fix, handledBy: f.handledBy },
      });
    }
    return out;
  }

  /** Closes the open node and the turn. */
  turnFinished(result: { status: string; stepSeq: number }, at: Date): Span[] {
    const out: Span[] = [];
    if (this.#node) out.push(this.#closeNode(at));
    const turn = this.#turn ?? this.turnStarted(at)[0];
    if (turn?.kind !== "turn") return out;
    const outcome = (["completed", "waiting", "handed_off", "ended", "failed"] as const).find(
      (s) => s === result.status,
    );
    this.#turn = {
      ...turn,
      status: result.status === "failed" ? "error" : "ok",
      durationMs: ms(new Date(turn.startedAt), at),
      attrs: { ...turn.attrs, ...(outcome ? { outcome } : {}), stepCount: result.stepSeq },
    };
    out.push(this.#turn);
    return out;
  }

  #closeNode(at: Date): NodeSpan {
    const node = this.#node as NodeSpan;
    const closed: NodeSpan = {
      ...node,
      durationMs: ms(new Date(node.startedAt), at),
      attrs: { ...node.attrs, ...(this.#lastOutcome ? { leftBy: this.#lastOutcome } : {}) },
    };
    this.#node = undefined;
    this.#lastOutcome = undefined;
    return closed;
  }

  #base(seq: number, name: string, start: Date, end: Date = start) {
    return {
      id: spanId(this.#ctx.turnId, seq),
      workspaceId: this.#ctx.workspaceId,
      botId: this.#ctx.botId,
      conversationId: this.#ctx.conversationId,
      turnId: this.#ctx.turnId,
      seq,
      name: name.slice(0, 200),
      status: "ok" as const,
      startedAt: start.toISOString(),
      durationMs: ms(start, end),
      location: {},
    };
  }

  #card(workflowId: string, nodeId: string, cardId: string) {
    const node = this.#definition.workflows.find((w) => w.id === workflowId)?.nodes.find((n) => n.id === nodeId);
    return node?.type === "standard" ? node.cards.find((c) => c.id === cardId) : undefined;
  }

  /** Values the step changed, by variable id, with sensitive ones redacted (ADR-009). */
  #writes(
    before: TraceBefore,
    step: TraceStep,
    workflowId: string,
  ): Record<string, { before: Json; after: Json }> | undefined {
    const workflow = this.#definition.workflows.find((w) => w.id === workflowId);
    const declared = new Map<string, Variable>(
      [...this.#definition.manifest.variables, ...(workflow?.variables ?? [])].map((v) => [v.id, v]),
    );
    const top = (s: ConversationState) => s.stack.at(-1)?.vars ?? {};
    const pairs: [Record<string, Json>, Record<string, Json>][] = [
      [before.state.conversationVars, step.state.conversationVars],
      [top(before.state), top(step.state)],
    ];
    const out: Record<string, { before: Json; after: Json }> = {};
    for (const [a, b] of pairs) {
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const was = a[id] ?? null;
        const now = b[id] ?? null;
        if (JSON.stringify(was) === JSON.stringify(now)) continue;
        out[id] = declared.get(id)?.sensitive ? { before: REDACTED, after: REDACTED } : { before: was, after: now };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Picks up a turn whose earlier steps were traced by another worker (a resumed turn). */
  #resume(existing: readonly Span[]) {
    const sorted = [...existing].sort((a, b) => a.seq - b.seq);
    this.#seq = (sorted.at(-1)?.seq ?? 0) + 1;
    const turn = sorted.find((s) => s.kind === "turn");
    if (turn?.kind === "turn") this.#turn = turn;
    const lastNode = [...sorted].reverse().find((s) => s.kind === "node");
    if (lastNode?.kind === "node" && lastNode.attrs.leftBy === undefined) {
      this.#node = lastNode;
      const lastCard = [...sorted].reverse().find((s) => s.kind === "card" && s.parentId === lastNode.id);
      this.#lastOutcome = lastCard?.kind === "card" ? lastCard.attrs.outcome : undefined;
    }
    const ends = sorted
      .filter((s) => s.kind !== "turn" && s.kind !== "node")
      .map((s) => new Date(s.startedAt).getTime() + s.durationMs);
    const last = Math.max(new Date(turn?.startedAt ?? 0).getTime(), ...ends);
    this.#boundary = new Date(last);
  }
}

const ms = (from: Date, to: Date) => Math.max(0, Math.round(to.getTime() - from.getTime()));
