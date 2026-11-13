/** worker service entry: load config, consume the selected queues, shut down cleanly. */
import { commonEnv, loadConfigOrExit, redisEnv, workerEnv } from "@wakeel/config";
import { createLogger } from "@wakeel/telemetry";
import { startWorkers } from "./workers";

const config = loadConfigOrExit({ ...commonEnv, ...redisEnv, ...workerEnv });
if (config) {
  const logger = createLogger({ service: "worker", level: config.logLevel });
  const running = startWorkers({
    redisUrl: config.redisUrl.reveal(),
    queues: config.queues,
    // Each phase registers its queue's processor here (turn: 4.4, webhook: 5.2, kb-*: 8.4, …).
    processors: {},
    logger,
  });

  try {
    await running.ready();
  } catch (err) {
    logger.fatal({ err }, "cannot connect to Redis");
    process.exit(1);
  }

  // With no queue to consume (early phases, or QUEUES naming only unbuilt queues) nothing would keep
  // the event loop alive and the process would exit 0, which an orchestrator restarts in a loop. A
  // service stays up until it is told to stop.
  const keepAlive = running.consuming.length === 0 ? setInterval(() => undefined, 60_000) : undefined;
  if (keepAlive) logger.warn({ idle: running.idle }, "no selected queue has a processor; staying up and idle");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down; waiting for jobs in flight");
    if (keepAlive) clearInterval(keepAlive);
    await running.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
