import { appendInboundEvent, type Database } from "@wakeel/db";
import type { Logger } from "@wakeel/telemetry";

export interface JanitorDeps {
  db: Database;
  logger: Logger;
  /** Adds a `turn` job for the conversation (deduplicated by conversation id). */
  enqueueTurn(conversationId: string): Promise<void>;
  /** Rows per scan; the next run picks up the rest. */
  batch?: number;
}

/**
 * The janitor (architecture §4.3, §4.4, ADR-008), run every 30 s on the `maintenance` queue:
 *
 * - inactivity: a waiting conversation past `expires_at` gets a `timeout` inbound event;
 * - recovery: a conversation with unprocessed events and no live lease gets a `turn` job, which
 *   covers a lost Redis job and a worker that died holding the lease.
 *
 * Postgres holds the truth, so nothing here is lost if Redis is; the janitor only wakes workers.
 */
export async function runJanitor(deps: JanitorDeps): Promise<{ timedOut: number; woken: number }> {
  const batch = deps.batch ?? 500;
  let timedOut = 0;
  for (const row of await deps.db.lookup.conversationsExpired(batch)) {
    await deps.db.withWorkspace(row.workspaceId, (tx) =>
      appendInboundEvent(tx, { conversationId: row.conversationId, kind: "timeout", payload: {} }),
    );
    timedOut++;
  }
  const toWake = await deps.db.lookup.conversationsToWake(batch);
  for (const row of toWake) await deps.enqueueTurn(row.conversationId);
  if (timedOut > 0 || toWake.length > 0) deps.logger.info({ timedOut, woken: toWake.length }, "janitor run");
  return { timedOut, woken: toWake.length };
}
