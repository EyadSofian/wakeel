import type { Job, Queue } from "bullmq";
import { modelId } from "../turn/handoff-summary";
import type { Processor } from "../workers";
import { type IngestDeps, type IngestJob, runStage } from "./ingest";
import { type SyncDeps, syncSource } from "./sources";

export { egressGet, mimeOf } from "./egress";
export { cleanMarkdown, type IngestDeps, type IngestJob, ingestDocument, runStage } from "./ingest";
export { rerankThroughEgress, turnKnowledge } from "./search";
export { enqueueDueSyncs, type SyncDeps, type SyncResult, syncSource } from "./sources";

/** `kb-ingest` (architecture §11): one stage per job, 5 attempts with exponential backoff. */
export function ingestEnqueuer(queue: Queue): (job: IngestJob) => Promise<void> {
  return async (job) => {
    const jobId = `${job.documentId}-${job.stage}`;
    // Failed jobs are kept for inspection (removeOnFail), and BullMQ silently drops an add whose id
    // exists in any state. Without this a stage that once failed could never run again.
    const previous = await queue.getJob(jobId);
    if (previous && (await previous.isFailed())) await previous.remove();
    await queue.add("stage", job, {
      // One live job per document stage: a duplicate request while it waits is dropped.
      jobId,
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: 1_000,
    });
  };
}

/**
 * The embed stage's model call. Knowledge bases store a `provider:id` reference; the registry names
 * models by id, as the query side already does (packages/retrieval/adapters/service.ts).
 */
export function ingestEmbedder(llm: {
  embed(request: {
    model: string;
    values: string[];
    purpose: string;
    context: { workspaceId: string; mode: "live"; botId: string };
  }): Promise<{ embeddings: number[][] }>;
}): IngestDeps["embed"] {
  return ({ workspaceId, botId, model }) =>
    async (values) =>
      (
        await llm.embed({
          model: modelId(model),
          values,
          purpose: "kb_embed",
          context: { workspaceId, mode: "live", botId },
        })
      ).embeddings;
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
      jobId: job.sourceId,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  };
}

export function syncProcessor(deps: SyncDeps): Processor {
  return async (job: Job) => {
    const { workspaceId, sourceId } = job.data as SyncJob;
    return syncSource(deps, workspaceId, sourceId);
  };
}
