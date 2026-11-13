import type { QueueName } from "@wakeel/config";
import { AppError } from "@wakeel/contracts";
import type { Logger } from "@wakeel/telemetry";
import { type Job, Worker } from "bullmq";

/**
 * BullMQ wiring (ADR-008: Postgres holds the truth, BullMQ only wakes workers). One BullMQ Worker per
 * queue this replica consumes (`QUEUES=`), each with structured logs per job. Processors are added by
 * the phases that own each queue; a selected queue without one is reported at start and not consumed,
 * so jobs wait instead of failing.
 */
export type Processor = (job: Job, log: Logger) => Promise<unknown>;

export interface WorkerOptions {
  redisUrl: string;
  queues: readonly QueueName[];
  processors: Partial<Record<QueueName, Processor>>;
  logger: Logger;
  /** Jobs in flight per queue in this process (turns are I/O bound; architecture §15). */
  concurrency?: number;
}

export interface RunningWorkers {
  /** Queues actually consumed. */
  consuming: QueueName[];
  /** Selected queues that have no processor yet. */
  idle: QueueName[];
  /** Waits for every worker to connect to Redis. */
  ready(): Promise<void>;
  /** Stops taking jobs and waits for in-flight jobs to finish. */
  close(): Promise<void>;
}

export function startWorkers(options: WorkerOptions): RunningWorkers {
  const consuming: QueueName[] = [];
  const idle: QueueName[] = [];
  const workers: Worker[] = [];

  for (const queue of options.queues) {
    const processor = options.processors[queue];
    if (!processor) {
      idle.push(queue);
      continue;
    }
    consuming.push(queue);
    const worker = new Worker(
      queue,
      async (job) => {
        const log = options.logger.child({ queue, jobId: job.id, jobName: job.name, attempt: job.attemptsMade + 1 });
        const started = Date.now();
        log.debug("job started");
        try {
          const result = await processor(job, log);
          log.info({ durationMs: Date.now() - started }, "job completed");
          return result;
        } catch (err) {
          const code = err instanceof AppError ? err.code : "internal_error";
          log.error({ err, code, durationMs: Date.now() - started }, "job failed");
          throw err;
        }
      },
      {
        // maxRetriesPerRequest must be null for workers' blocking commands (BullMQ requirement).
        connection: { url: options.redisUrl, maxRetriesPerRequest: null },
        concurrency: options.concurrency ?? 1,
      },
    );
    worker.on("error", (err) => options.logger.error({ err, queue }, "queue connection error"));
    workers.push(worker);
  }

  options.logger.info(
    { consuming, idle },
    idle.length > 0 ? "workers started; some queues have no processor yet" : "workers started",
  );

  return {
    consuming,
    idle,
    async ready() {
      await Promise.all(workers.map((w) => w.waitUntilReady()));
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
