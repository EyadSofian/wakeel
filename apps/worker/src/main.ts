/** worker service entry: load config, consume the selected queues, shut down cleanly. */
import { hostname } from "node:os";
import {
  commonEnv,
  databaseEnv,
  egressClientEnv,
  KB_LIMITS,
  loadConfigOrExit,
  masterKeyEnv,
  objectStoreEnv,
  parserClientEnv,
  redisEnv,
  sandboxClientEnv,
  WORKER_LIMITS,
  workerEnv,
} from "@wakeel/config";
import { AppError, mintCapabilityToken } from "@wakeel/contracts";
import { createDatabase, s3ObjectStore } from "@wakeel/db";
import { createLlm } from "@wakeel/llm";
import { CRAWLER_USER_AGENT, httpParser, visionOcr } from "@wakeel/retrieval";
import {
  createAutonomyRunPort,
  createCodePort,
  createExpressionPort,
  createSandboxClient,
} from "@wakeel/sandbox-client";
import { createLogger } from "@wakeel/telemetry";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  egressGet,
  enqueueDueSyncs,
  ingestEnqueuer,
  ingestProcessor,
  mimeOf,
  syncEnqueuer,
  syncProcessor,
} from "./kb/index";
import {
  aiPort,
  autonomyPort,
  maintenanceProcessor,
  modelHandoffSummary,
  recordUsage,
  type TurnDeps,
  turnEnqueuer,
  turnFollowUp,
  turnProcessor,
  workspaceCredentials,
} from "./turn/index";
import { egressSender, webhookEnqueuer, webhookFollowUp, webhookProcessor } from "./webhook/index";
import { startWorkers } from "./workers";

const config = loadConfigOrExit({
  ...commonEnv,
  ...redisEnv,
  ...workerEnv,
  ...databaseEnv,
  ...sandboxClientEnv,
  ...egressClientEnv,
  ...masterKeyEnv,
  // Knowledge base ingestion (task 8.4): the object store and the parser service.
  ...objectStoreEnv,
  ...parserClientEnv,
});
if (config) {
  const logger = createLogger({ service: "worker", level: config.logLevel });
  const redisUrl = config.redisUrl.reveal();
  const db = createDatabase({ url: config.databaseUrl, applicationName: "wakeel-worker" });
  try {
    await db.verify();
  } catch (err) {
    logger.fatal({ err }, "refusing to start: the database role can bypass row-level security");
    process.exit(1);
  }

  const connection = { url: redisUrl, maxRetriesPerRequest: null };
  const turnQueue = new Queue("turn", { connection });
  const maintenanceQueue = new Queue("maintenance", { connection });
  const webhookQueue = new Queue("webhook", { connection });
  const ingestQueue = new Queue("kb-ingest", { connection });
  const syncQueue = new Queue("kb-sync", { connection });
  const enqueueIngest = ingestEnqueuer(ingestQueue);
  const enqueueSync = syncEnqueuer(syncQueue);
  const egressFor = (workspaceId: string) =>
    egressGet({ egressUrl: config.egressUrl, egressToken: config.egressToken.reveal(), workspaceId });
  const realClock = {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
  const webhooks = webhookEnqueuer(webhookQueue);
  const publisher = new Redis(redisUrl);
  const sandbox = createSandboxClient({ url: config.sandboxUrl });
  const capabilityKey = config.egressCapabilityKey.reveal();
  const keyring = {
    current: { version: config.masterKeyVersion, key: config.masterKey.reveal() },
    previous: config.previousMasterKeys.reveal(),
  };
  // The model layer (task 6.1): workspace keys only, one usage event per call.
  const usage = recordUsage(db);
  const llm = createLlm({
    credentials: workspaceCredentials(db, keyring),
    onUsage: (e) => usage(e).catch((err: unknown) => logger.error({ err, model: e.model }, "usage event not written")),
  });
  const runPort = createAutonomyRunPort(sandbox);
  const objectStore = s3ObjectStore({
    endpoint: config.s3Endpoint,
    ...(config.s3PublicEndpoint ? { publicEndpoint: config.s3PublicEndpoint } : {}),
    region: config.s3Region,
    bucket: config.s3Bucket,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey.reveal(),
  });
  const parser = httpParser({
    url: config.parserUrl,
    token: config.parserToken.reveal(),
    timeoutMs: KB_LIMITS.parserTimeoutMs,
  });

  const turnDeps: TurnDeps = {
    db,
    owner: `${hostname()}:${process.pid}`,
    logger,
    enginePorts: ({ workspaceId }) => ({
      sandbox: createExpressionPort(sandbox),
      code: createCodePort(sandbox, {
        // One token per exec, valid a little longer than the longest code run (ADR-023 §4).
        capabilityToken: (exec) =>
          mintCapabilityToken(capabilityKey, { ws: workspaceId, exec, exp: Math.floor(Date.now() / 1000) + 90 }),
      }),
    }),
    publish: async (channel, message) => {
      await publisher.publish(channel, message);
    },
    enqueueWebhook: webhooks.now,
    autonomy: (turn, code) => autonomyPort({ db, llm, runPort, logger }, turn, code),
    // AI cards and the handoff summary use the same client: workspace keys, one usage event per call.
    ai: (turn) => aiPort({ llm }, turn),
    summarizeHandoff: modelHandoffSummary({ db, model: llm }),
    keyring,
  };

  const running = startWorkers({
    redisUrl,
    queues: config.queues,
    processors: {
      turn: turnProcessor(turnDeps),
      maintenance: maintenanceProcessor(
        {
          db,
          logger,
          enqueueTurn: turnEnqueuer(turnQueue),
          enqueueWebhook: webhooks.now,
        },
        // Scheduled knowledge base re-sync (task 8.5): finds due sources and adds kb-sync jobs.
        { "kb-resync": () => enqueueDueSyncs({ db, enqueueSync }, new Date()) },
      ),
      "kb-ingest": ingestProcessor({
        db,
        objectStore,
        parser,
        // ADR-041 §4: the OCR tier uses the knowledge base's vision model; none set means no OCR.
        ocr: async ({ workspaceId, botId, settings }) => {
          const model = settings.ocrModel;
          if (!model) return undefined;
          return visionOcr(async (input) =>
            llm.readImage({ ...input, model, purpose: "kb_ocr", context: { workspaceId, mode: "live", botId } }),
          );
        },
        embed:
          ({ workspaceId, botId, model }) =>
          async (values) =>
            (
              await llm.embed({
                model,
                values,
                purpose: "kb_embed",
                context: { workspaceId, mode: "live", botId },
              })
            ).embeddings,
        // URL, sitemap and crawl pages are fetched through egress (ADR-020), never directly.
        fetchRemote: async ({ workspaceId, url }) => {
          const res = await egressFor(workspaceId)(url, { "user-agent": CRAWLER_USER_AGENT });
          if (res.status !== 200)
            throw new AppError("source_fetch_failed", { url, message: `the page answered ${res.status}` });
          return { body: res.body, mime: mimeOf(res), name: url };
        },
        enqueue: enqueueIngest,
        logger,
      }),
      "kb-sync": syncProcessor({
        db,
        get: egressFor,
        clock: realClock,
        minIntervalMs: KB_LIMITS.crawlMinIntervalMs,
        enqueueIngest,
        logger,
      }),
      webhook: webhookProcessor({
        db,
        logger,
        sender: egressSender({ egressUrl: config.egressUrl, egressToken: config.egressToken.reveal() }),
        keyring,
        scheduleWake: webhooks.at,
      }),
    },
    onCompleted: {
      turn: turnFollowUp({ db, logger, enqueueTurn: turnEnqueuer(turnQueue) }),
      webhook: webhookFollowUp({ db, logger, enqueueWebhook: webhooks.now }),
    },
    logger,
    concurrency: WORKER_LIMITS.concurrentTurnsPerProcess,
  });

  try {
    await running.ready();
    // One schedule for the whole deployment: upserting by id is idempotent across replicas.
    if (config.queues.includes("maintenance"))
      await maintenanceQueue.upsertJobScheduler(
        "janitor",
        { every: WORKER_LIMITS.janitorIntervalSeconds * 1000 },
        { name: "janitor", opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    if (config.queues.includes("maintenance"))
      await maintenanceQueue.upsertJobScheduler(
        "kb-resync",
        { every: KB_LIMITS.resyncScanSeconds * 1000 },
        { name: "kb-resync", opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
  } catch (err) {
    logger.fatal({ err }, "cannot connect to Redis");
    process.exit(1);
  }

  // With no queue to consume (QUEUES naming only unbuilt queues) nothing would keep the event loop
  // alive and the process would exit 0, which an orchestrator restarts in a loop. A service stays up
  // until it is told to stop.
  const keepAlive = running.consuming.length === 0 ? setInterval(() => undefined, 60_000) : undefined;
  if (keepAlive) logger.warn({ idle: running.idle }, "no selected queue has a processor; staying up and idle");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down; waiting for jobs in flight");
    if (keepAlive) clearInterval(keepAlive);
    await running.close();
    await Promise.all([
      turnQueue.close(),
      maintenanceQueue.close(),
      webhookQueue.close(),
      ingestQueue.close(),
      syncQueue.close(),
      publisher.quit(),
      db.close(),
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
