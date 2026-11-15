import type { Job, Queue } from "bullmq";
import type { Processor } from "../workers";
import { type IngestDeps, type IngestJob, runStage } from "./ingest";

export { cleanMarkdown, type IngestDeps, type IngestJob, ingestDocument, runStage } from "./ingest";

/** `kb-ingest` (architecture §11): one stage per job, 5 attempts with exponential backoff. */
export function ingestEnqueuer(queue: Queue): (job: IngestJob) => Promise<void> {
  return async (job) => {
    await queue.add("stage", job, {
      // One live job per document stage: a duplicate request while it waits is dropped.
      jobId: `${job.documentId}:${job.stage}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: 1_000,
    });
  };
}

export function ingestProcessor(deps: IngestDeps): Processor {
  return async (job: Job) => runStage(deps, job.data as IngestJob);
}
