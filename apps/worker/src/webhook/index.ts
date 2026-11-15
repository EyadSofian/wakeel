import { type Database, loadDeliveryStream } from "@wakeel/db";
import type { Logger } from "@wakeel/telemetry";
import type { Job, Queue } from "bullmq";
import type { Processor } from "../workers";
import { type DeliverResult, deliverConversation, type WebhookDeps } from "./deliver";

export { egressSender, type SendResult, type WebhookRequest, type WebhookSender } from "@wakeel/bridge";
export * from "./deliver";
export * from "./schedule";

export interface WebhookJob {
  conversationId: string;
}

/**
 * Wakes a conversation's delivery stream (ADR-028 §4). `now` uses the conversation id as the job id,
 * so a job already waiting is enough. `at` adds a delayed job with its own id (conversation and
 * delivery), so a retry is not swallowed by the job that schedules it while still running.
 */
export function webhookEnqueuer(queue: Queue) {
  const options = { removeOnComplete: true, removeOnFail: true } as const;
  return {
    now: async (conversationId: string) => {
      await queue.add("webhook", { conversationId } satisfies WebhookJob, { ...options, jobId: conversationId });
    },
    at: async (conversationId: string, deliveryId: string, at: Date) => {
      await queue.add("webhook", { conversationId } satisfies WebhookJob, {
        ...options,
        jobId: `${conversationId}-${deliveryId}`,
        delay: Math.max(0, at.getTime() - Date.now()),
      });
    },
  };
}

export function webhookProcessor(deps: WebhookDeps): Processor {
  return async (job) => {
    const { conversationId } = job.data as WebhookJob;
    return deliverConversation(deps, conversationId);
  };
}

/**
 * After a `webhook` job completes and BullMQ has removed it: if the stream stopped at its limit, or
 * stopped drained but a due delivery has been written since, wake it again. A delivery committed
 * while the job was finishing had its wake-up dropped as a duplicate of the still-active job.
 */
export function webhookFollowUp(deps: {
  db: Database;
  logger: Logger;
  enqueueWebhook: (conversationId: string) => Promise<void>;
}): (job: Job, result: unknown) => Promise<void> {
  return async (job, result) => {
    const { conversationId } = job.data as WebhookJob;
    const r = result as DeliverResult | undefined;
    if (r?.stopped !== "drained" && r?.stopped !== "limit") return;
    if (r.stopped === "drained") {
      const workspaceId = await deps.db.lookup.conversationWorkspace(conversationId);
      if (!workspaceId) return;
      const stream = await deps.db.withWorkspace(workspaceId, (tx) => loadDeliveryStream(tx, conversationId));
      const due =
        stream?.connection.status === "active" &&
        (stream.outOfBand.length > 0 ||
          (stream.head !== undefined && stream.head.nextAttemptAt.getTime() <= Date.now()));
      if (!due) return;
    }
    deps.logger.info({ conversationId, stopped: r.stopped }, "deliveries left after the job finished; enqueued again");
    await deps.enqueueWebhook(conversationId);
  };
}
