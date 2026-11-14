/** worker service entry: load config, consume the selected queues, shut down cleanly. */
import { hostname } from "node:os";
import {
  commonEnv,
  databaseEnv,
  egressClientEnv,
  loadConfigOrExit,
  masterKeyEnv,
  redisEnv,
  sandboxClientEnv,
  WORKER_LIMITS,
  workerEnv,
} from "@wakeel/config";
import { mintCapabilityToken } from "@wakeel/contracts";
import { createDatabase } from "@wakeel/db";
import { createLlm } from "@wakeel/llm";
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
  autonomyPort,
  maintenanceProcessor,
  recordUsage,
  type TurnDeps,
  turnEnqueuer,
  turnProcessor,
  workspaceCredentials,
} from "./turn/index";
import { egressSender, webhookEnqueuer, webhookProcessor } from "./webhook/index";
import { startWorkers } from "./workers";

const config = loadConfigOrExit({
  ...commonEnv,
  ...redisEnv,
  ...workerEnv,
  ...databaseEnv,
  ...sandboxClientEnv,
  ...egressClientEnv,
  ...masterKeyEnv,
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
  };

  const running = startWorkers({
    redisUrl,
    queues: config.queues,
    processors: {
      turn: turnProcessor(turnDeps),
      maintenance: maintenanceProcessor({
        db,
        logger,
        enqueueTurn: turnEnqueuer(turnQueue),
        enqueueWebhook: webhooks.now,
      }),
      webhook: webhookProcessor({
        db,
        logger,
        sender: egressSender({ egressUrl: config.egressUrl, egressToken: config.egressToken.reveal() }),
        keyring,
        scheduleWake: webhooks.at,
      }),
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
      publisher.quit(),
      db.close(),
    ]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
