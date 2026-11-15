import type { Job, Queue } from "bullmq";
import type { Processor } from "../workers";
import { type IngestDeps, type IngestJob, runStage } from "./ingest";
import { type SyncDeps, syncSource } from "./sources";

export { egressGet, mimeOf } from "./egress";
export { cleanMarkdown, type IngestDeps, type IngestJob, ingestDocument, runStage } from "./ingest";
export { enqueueDueSyncs, type SyncDeps, type SyncResult, syncSource } from "./sources";

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

export interface SyncJob {
  workspaceId: string;
  sourceId: string;
}

/** `kb-sync` (architecture §11): one job per source, 3 attempts. */
export function syncEnqueuer(queue: Queue): (job: SyncJob) => Promise<void> {
  return async (job) => {
    await queue.add("sync", job, {
      jobId: `sync:${job.sourceId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 1_000,
    });
  };
}

export function syncProcessor(deps: SyncDeps): Processor {
  return async (job: Job) => {
    const { workspaceId, sourceId } = job.data as SyncJob;
    return syncSource(deps, workspaceId, sourceId);
  };
}
