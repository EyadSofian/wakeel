/** api service entry: load config, check dependencies, listen, shut down cleanly. */
import { createAuthService } from "@wakeel/auth";
import { egressSender } from "@wakeel/bridge";
import {
  API_LIMITS,
  apiEnv,
  authEnv,
  commonEnv,
  databaseEnv,
  egressClientEnv,
  loadConfigOrExit,
  masterKeyEnv,
  redisEnv,
} from "@wakeel/config";
import { createDatabase } from "@wakeel/db";
import { createLogger } from "@wakeel/telemetry";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { Signals } from "./routes/bridge/signals";

const config = loadConfigOrExit({
  ...commonEnv,
  ...databaseEnv,
  ...redisEnv,
  ...apiEnv,
  ...authEnv,
  // testWebhook signs and sends through egress (ADR-029 §4).
  ...egressClientEnv,
  ...masterKeyEnv,
});
if (config) {
  const logger = createLogger({ service: "api", level: config.logLevel });
  const db = createDatabase({ url: config.databaseUrl, applicationName: "wakeel-api" });
  const redis = new Redis(config.redisUrl.reveal(), { lazyConnect: true, maxRetriesPerRequest: 1 });

  try {
    // Refuse to start as a role that bypasses row-level security (ADR-004).
    const { role } = await db.verify();
    await redis.connect();
    logger.info({ dbRole: role, apiRole: config.role }, "dependencies ready");
  } catch (err) {
    logger.fatal({ err }, "cannot start");
    process.exit(1);
  }

  const auth = createAuthService({
    db,
    redis,
    secret: config.authSecret.reveal(),
    baseUrl: config.apiPublicUrl,
    studioOrigin: config.studioOrigin,
    signInFailuresPerMinute: API_LIMITS.signInFailuresPerMinute,
  });

  // The Bridge API enqueues turns and waits on their signals (§4.2, §9.3).
  const redisUrl = config.redisUrl.reveal();
  const subscriber = new Redis(redisUrl);
  const turnQueue = new Queue("turn", { connection: { url: redisUrl, maxRetriesPerRequest: null } });
  const webhookQueue = new Queue("webhook", { connection: { url: redisUrl, maxRetriesPerRequest: null } });
  const keyring = {
    current: { version: config.masterKeyVersion, key: config.masterKey.reveal() },
    previous: config.previousMasterKeys.reveal(),
  };
  const app = buildApp({
    role: config.role,
    logger,
    studio: { auth, studioOrigin: config.studioOrigin, db, keyring },
    bridge: {
      db,
      signals: new Signals(subscriber),
      enqueueTurn: async (conversationId) => {
        await turnQueue.add(
          "turn",
          { conversationId },
          { jobId: conversationId, removeOnComplete: true, removeOnFail: true },
        );
      },
      enqueueWebhook: async (conversationId) => {
        await webhookQueue.add(
          "webhook",
          { conversationId },
          { jobId: conversationId, removeOnComplete: true, removeOnFail: true },
        );
      },
      sender: egressSender({ egressUrl: config.egressUrl, egressToken: config.egressToken.reveal() }),
      keyring,
    },
    readiness: {
      database: async () => void (await db.verify()),
      redis: async () => {
        if ((await redis.ping()) !== "PONG") throw new Error("unexpected PING reply");
      },
    },
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await Promise.allSettled([db.close(), redis.quit(), subscriber.quit(), turnQueue.close(), webhookQueue.close()]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}
