import { Payload, Span } from "@wakeel/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { traceSpans } from "../schema/runtime";
import { currentWorkspace } from "./scope";

/**
 * Trace spans (task 4.7, ADR-009, ADR-026). Spans are upserted by id: the turn and node spans are
 * written when they open and again when they close. Every span is parsed with the contract's schema
 * before it is written and after it is read.
 */
export async function upsertSpans(
  tx: Tx,
  spans: readonly Span[],
  payloadKeys: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
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
      payloadKey: payloadKeys.get(s.id) ?? null,
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
        payloadKey: sql`excluded.payload_key`,
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

/** A client selects a payload field on an authorized span, never an object-store path. */
export async function tracePayloadKey(
  tx: Tx,
  turnId: string,
  spanId: string,
  field: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ attrs: traceSpans.attrs, key: traceSpans.payloadKey })
    .from(traceSpans)
    .where(sql`${traceSpans.turnId} = ${turnId} and ${traceSpans.id} = ${spanId}`)
    .limit(1);
  if (!row?.key || !row.attrs || typeof row.attrs !== "object" || !Object.hasOwn(row.attrs, field)) return;
  const ref = Payload.safeParse((row.attrs as Record<string, unknown>)[field]);
  return ref.success && !ref.data.inline && ref.data.key === field ? row.key : undefined;
}

/** Delete a bounded tenant batch and retain its object keys until deletion succeeds. */
export async function expireTraceSpans(tx: Tx, cutoff: Date): Promise<number> {
  const result = await tx.execute(sql`with expired as (
    select id, started_at from trace_spans where started_at < ${cutoff.toISOString()}
    order by started_at, id limit 1000 for update skip locked
  ), removed as (
    delete from trace_spans s using expired e where s.id=e.id and s.started_at=e.started_at
    returning s.workspace_id, s.payload_key
  ), queued as (
    insert into trace_payload_deletions (workspace_id, payload_key)
    select workspace_id, payload_key from removed where payload_key is not null
    on conflict do nothing
  ) select count(*)::int as removed from removed`);
  return Number(result.rows[0]?.["removed"] ?? 0);
}

export async function pendingTracePayloadDeletes(tx: Tx) {
  const result = await tx.execute(sql`select payload_key from trace_payload_deletions order by created_at limit 1000`);
  return result.rows.map((row) => String(row["payload_key"]));
}

export async function acknowledgeTracePayloadDeletes(tx: Tx, keys: string[]) {
  if (keys.length === 0) return;
  await tx.execute(sql`delete from trace_payload_deletions where payload_key = any(${sql.param(keys)}::text[])`);
}
