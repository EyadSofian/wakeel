import { type Database, nextUnprocessedEvent } from "@wakeel/db";
import type { Logger } from "@wakeel/telemetry";
import type { Job, Queue } from "bullmq";
import type { Processor } from "../workers";
import { type DrainResult, drainConversation, type TurnDeps } from "./drain";
import { type JanitorDeps, runJanitor } from "./janitor";

export * from "./autonomy";
export * from "./drain";
export * from "./event-scope";
export * from "./handoff-summary";
export * from "./janitor";
export * from "./message-id";

export interface TurnJob {
  conversationId: string;
}

/**
 * Enqueues a `turn` job for a conversation. The job id is the conversation id (§4.2), so a job
 * already waiting is enough; finished jobs are removed so the next message can enqueue again.
 */
export function turnEnqueuer(queue: Queue): (conversationId: string) => Promise<void> {
  return async (conversationId) => {
    await queue.add("turn", { conversationId } satisfies TurnJob, {
      jobId: conversationId,
      removeOnComplete: true,
      removeOnFail: true,
    });
  };
}

/**
 * After a `turn` job completes and BullMQ has removed it: if the conversation's inbox is not empty,
 * enqueue it again. A message that arrived while the job was finishing had its own `add` dropped as
 * a duplicate of the still-active job (same id), and would otherwise wait for the janitor (30 s).
 */
export function turnFollowUp(deps: {
  db: Database;
  logger: Logger;
  enqueueTurn: (conversationId: string) => Promise<void>;
}): (job: Job, result: unknown) => Promise<void> {
  return async (job, result) => {
    const { conversationId } = job.data as TurnJob;
    const r = result as DrainResult | undefined;
    // Leased elsewhere or lost: that worker, or the janitor, owns the conversation.
    if (r?.stopped !== "drained") return;
    const workspaceId = await deps.db.lookup.conversationWorkspace(conversationId);
    if (!workspaceId) return;
    const waiting = await deps.db.withWorkspace(workspaceId, (tx) => nextUnprocessedEvent(tx, conversationId));
    if (!waiting) return;
    deps.logger.info({ conversationId }, "message arrived while the turn job finished; enqueued again");
    await deps.enqueueTurn(conversationId);
  };
}

export function turnProcessor(deps: TurnDeps): Processor {
  return async (job) => {
    const { conversationId } = job.data as TurnJob;
    return drainConversation(deps, conversationId);
  };
}

/** The `maintenance` queue: `janitor` jobs run the janitor; other names belong to later phases. */
export function maintenanceProcessor(deps: JanitorDeps): Processor {
  return async (job, log) => {
    if (job.name === "janitor") return runJanitor(deps);
    log.warn({ jobName: job.name }, "no maintenance task by this name yet");
    return undefined;
  };
}
