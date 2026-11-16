import { loadConfig } from "./config";
import { fetchHttp } from "./http";
import { createAdapterServer } from "./server";
import { memoryStore, redisStore } from "./store";

const config = loadConfig(process.env);
const store = config.redisUrl ? redisStore(config.redisUrl) : memoryStore();
const log = (level: "info" | "warn" | "error", msg: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: "adapter-chatwoot", msg, ...data }));

const server = createAdapterServer({
  config,
  store,
  http: fetchHttp,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
});
server.listen(config.port, config.host, () =>
  log("info", "listening", {
    port: config.port,
    pairs: config.pairs.map((p) => p.id.slice(0, 4)),
    store: config.redisUrl ? "redis" : "memory",
  }),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
