/** api service entry: load config, check dependencies, listen, shut down cleanly. */
import { createAuthService } from "@wakeel/auth";
import { API_LIMITS, apiEnv, authEnv, commonEnv, databaseEnv, loadConfigOrExit, redisEnv } from "@wakeel/config";
import { createDatabase } from "@wakeel/db";
import { createLogger } from "@wakeel/telemetry";
import { Redis } from "ioredis";
import { buildApp } from "./app";

const config = loadConfigOrExit({ ...commonEnv, ...databaseEnv, ...redisEnv, ...apiEnv, ...authEnv });
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

  const app = buildApp({
    role: config.role,
    logger,
    studio: { auth, studioOrigin: config.studioOrigin, db },
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
    await Promise.allSettled([db.close(), redis.quit()]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}
