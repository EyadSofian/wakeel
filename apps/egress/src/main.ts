/** egress service entry: load config, listen, shut down cleanly. */
import { commonEnv, egressEnv, loadConfigOrExit } from "@wakeel/config";
import { createLogger } from "@wakeel/telemetry";
import { systemClock } from "./clock";
import { systemResolver } from "./resolver";
import { createEgressServer } from "./server";

const config = loadConfigOrExit({ ...commonEnv, ...egressEnv });

// With this set, Node sends requests through HTTP_PROXY / HTTPS_PROXY instead of the address egress
// checked, which would bypass DNS pinning. Refuse to start rather than run without the guarantee.
if (config && process.env["NODE_USE_ENV_PROXY"]) {
  process.stderr.write("NODE_USE_ENV_PROXY is set. Unset it: egress must dial the addresses it checks itself.\n");
  process.exit(1);
}

if (config) {
  const logger = createLogger({ service: "egress", level: config.logLevel });
  const server = createEgressServer({
    token: config.egressToken.reveal(),
    capabilityKey: config.egressCapabilityKey.reveal(),
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
