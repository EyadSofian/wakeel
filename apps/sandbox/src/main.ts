/**
 * sandbox service entry: load config, start the runner pool, listen, shut down cleanly.
 * Its environment holds only its own settings (architecture §5.3, layer 2).
 */
import { commonEnv, loadConfigOrExit, SANDBOX_LIMITS, sandboxEnv } from "@wakeel/config";
import { createLogger } from "@wakeel/telemetry";
import { SandboxPool } from "./pool.ts";
import { createSandboxServer } from "./server.ts";

const config = loadConfigOrExit({ ...commonEnv, ...sandboxEnv });
if (config) {
  const logger = createLogger({ service: "sandbox", level: config.logLevel });
  const pool = new SandboxPool({
    size: config.sandboxPoolSize,
    egressUrl: config.sandboxEgressUrl,
    onKill: ({ execId, reason }) => logger.warn({ execId, reason }, "runner killed"),
  });

  try {
    await pool.start();
  } catch (err) {
    // No fallback (ADR-003): without QuickJS the service stays up, unready, so the failure is visible.
    logger.fatal({ err }, "QuickJS could not load; the sandbox is unhealthy");
  }

  const server = createSandboxServer({ pool, logger, requestFrameBytes: SANDBOX_LIMITS.requestFrameBytes });
  server.listen(config.sandboxPort, config.sandboxHost, () => {
    logger.info({ host: config.sandboxHost, port: config.sandboxPort, pool: pool.health() }, "listening");
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await server.close();
    await pool.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
