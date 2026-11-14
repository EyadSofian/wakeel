import { Span } from "@wakeel/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { traceSpans } from "../schema/runtime";
import { currentWorkspace } from "./scope";

/**
 * Trace spans (task 4.7, ADR-009, ADR-026). Spans are upserted by id: the turn and node spans are
 * written when they open and again when they close. Every span is parsed with the contract's schema
 * before it is written and after it is read.
 */
export async function upsertSpans(tx: Tx, spans: readonly Span[]): Promise<void> {
  if (spans.length === 0) return;
  const rows = spans.map((input) => {
    const s = Span.parse(input);
    return {
      id: s.id,
      workspaceId: currentWorkspace,
      botId: s.botId,
      conversationId: s.conversationId,
      turnId: s.turnId,
      parentId: s.parentId ?? null,
      seq: s.seq,
      kind: s.kind,
      name: s.name,
      status: s.status,
      startedAt: new Date(s.startedAt),
      durationMs: s.durationMs,
      location: s.location,
      attrs: s.attrs,
    };
  });
  await tx
    .insert(traceSpans)
    .values(rows)
    .onConflictDoUpdate({
      target: [traceSpans.id, traceSpans.startedAt],
      set: {
        name: sql`excluded.name`,
        status: sql`excluded.status`,
        durationMs: sql`excluded.duration_ms`,
        attrs: sql`excluded.attrs`,
      },
    });
}

/** A turn's spans in order (`Trace.spans`). */
export async function listTurnSpans(tx: Tx, turnId: string): Promise<Span[]> {
  const rows = await tx.select().from(traceSpans).where(eq(traceSpans.turnId, turnId)).orderBy(asc(traceSpans.seq));
  return rows.map((r) =>
    Span.parse({
      id: r.id,
      workspaceId: r.workspaceId,
      botId: r.botId,
      conversationId: r.conversationId,
      turnId: r.turnId,
      ...(r.parentId ? { parentId: r.parentId } : {}),
      seq: r.seq,
      kind: r.kind,
      name: r.name,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      location: r.location,
      attrs: r.attrs,
    }),
  );
}
