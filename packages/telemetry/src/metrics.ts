import { createServer } from "node:http";

type Label = "provider" | "queue" | "status" | "mode" | "reason";
type Labels = Partial<Record<Label, string>>;
const counters = new Map<string, { type: "counter" | "gauge"; rows: Map<string, number> }>();
const histograms = new Map<string, Map<string, { count: number; sum: number; buckets: number[] }>>();
const bounds = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 120];
const names = {
  wakeel_turn_duration_seconds: "histogram",
  wakeel_queue_depth: "gauge",
  wakeel_lease_contention_total: "counter",
  wakeel_sandbox_exec_seconds: "histogram",
  wakeel_sandbox_kills_total: "counter",
  wakeel_llm_errors_total: "counter",
  wakeel_webhook_attempts_total: "counter",
  wakeel_rls_denied_total: "counter",
  wakeel_trace_failures_total: "counter",
} as const;
type Metric = keyof typeof names;

function labelKey(labels: Labels) {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (!/^[a-z0-9_-]{1,48}$/.test(value)) throw new TypeError("Use a fixed metric label.");
      return `${key}="${value}"`;
    })
    .join(",");
}

/** Deployment metadata only. Callers must never use tenant IDs or content as label values. */
export function countMetric(name: Metric, labels: Labels = {}, value = 1) {
  if (names[name] !== "counter" || !Number.isFinite(value) || value < 0) throw new TypeError("Invalid counter update.");
  const metric = counters.get(name) ?? { type: "counter", rows: new Map<string, number>() };
  const key = labelKey(labels);
  metric.rows.set(key, (metric.rows.get(key) ?? 0) + value);
  counters.set(name, metric);
}

export function gaugeMetric(name: Metric, labels: Labels, value: number) {
  if (names[name] !== "gauge" || !Number.isFinite(value) || value < 0) throw new TypeError("Invalid gauge update.");
  const metric = counters.get(name) ?? { type: "gauge", rows: new Map<string, number>() };
  metric.rows.set(labelKey(labels), value);
  counters.set(name, metric);
}

export function observeMetric(name: Metric, labels: Labels, seconds: number) {
  if (names[name] !== "histogram" || !Number.isFinite(seconds) || seconds < 0)
    throw new TypeError("Invalid observation.");
  const histogram = histograms.get(name) ?? new Map();
  const key = labelKey(labels);
  const state = histogram.get(key) ?? { count: 0, sum: 0, buckets: bounds.map(() => 0) };
  state.count++;
  state.sum += seconds;
  for (const [index, bound] of bounds.entries())
    if (seconds <= bound) state.buckets[index] = (state.buckets[index] ?? 0) + 1;
  histogram.set(key, state);
  histograms.set(name, histogram);
}

const suffix = (key: string) => (key ? `{${key}}` : "");

/** Prometheus text exposition with cumulative histogram buckets and bounded labels. */
export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, type] of Object.entries(names)) {
    lines.push(`# TYPE ${name} ${type}`);
    if (type === "histogram") {
      for (const [key, row] of histograms.get(name) ?? []) {
        for (const [i, bound] of [...bounds, "+Inf"].entries()) {
          const bucketKey = [key, `le="${bound}"`].filter(Boolean).join(",");
          lines.push(`${name}_bucket${suffix(bucketKey)} ${row.buckets[i] ?? row.count}`);
        }
        lines.push(`${name}_sum${suffix(key)} ${row.sum}`, `${name}_count${suffix(key)} ${row.count}`);
      }
    } else {
      const metric = counters.get(name);
      if (metric) for (const [key, value] of metric.rows) lines.push(`${name}${suffix(key)} ${value}`);
      else lines.push(`${name} 0`);
    }
  }
  return lines.join("\n") + "\n";
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Private-network listener for the worker, whose main process does not have a web server. */
export async function startMetricsServer(port: number, refresh: () => Promise<void>) {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/metrics") {
      response.writeHead(404).end();
      return;
    }
    try {
      await refresh();
      response.writeHead(200, { "content-type": METRICS_CONTENT_TYPE }).end(renderMetrics());
    } catch {
      response.writeHead(503).end("Metrics dependencies are unavailable.\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "::", resolve);
  });
  return () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
