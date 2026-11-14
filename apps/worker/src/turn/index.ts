import type { Queue } from "bullmq";
import type { Processor } from "../workers";
import { drainConversation, type TurnDeps } from "./drain";
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
