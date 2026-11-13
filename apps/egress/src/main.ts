/** egress service entry: load config, listen, shut down cleanly. */
import { commonEnv, egressEnv, loadConfigOrExit } from "@wakeel/config";
import { createLogger } from "@wakeel/telemetry";
import { systemClock } from "./clock";
import { systemResolver } from "./resolver";
import { createEgressServer } from "./server";

const config = loadConfigOrExit({ ...commonEnv, ...egressEnv });
if (config) {
  const logger = createLogger({ service: "egress", level: config.logLevel });
  const server = createEgressServer({
    token: config.egressToken.reveal(),
    resolver: systemResolver,
    clock: systemClock,
    rate: { perMinute: config.egressRatePerMinute, burst: config.egressRateBurst },
    logger,
  });
  server.listen(config.egressPort, config.egressHost, () => {
    logger.info({ host: config.egressHost, port: config.egressPort }, "egress listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down; finishing requests in flight");
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
