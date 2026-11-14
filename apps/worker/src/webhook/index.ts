import type { Queue } from "bullmq";
import type { Processor } from "../workers";
import { deliverConversation, type WebhookDeps } from "./deliver";

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
