import { expect, test } from "vitest";
import { countMetric, gaugeMetric, observeMetric, renderMetrics } from "../src/metrics";

test("exports counters, gauges and cumulative histograms in Prometheus format", () => {
  countMetric("wakeel_llm_errors_total", { provider: "openai" }, 2);
  gaugeMetric("wakeel_queue_depth", { queue: "turn", status: "waiting" }, 4);
  observeMetric("wakeel_turn_duration_seconds", { mode: "live" }, 0.05);
  observeMetric("wakeel_turn_duration_seconds", { mode: "live" }, 2);
  const metrics = renderMetrics();
  expect(metrics).toContain('wakeel_llm_errors_total{provider="openai"} 2');
  expect(metrics).toContain('wakeel_queue_depth{queue="turn",status="waiting"} 4');
  expect(metrics).toContain('wakeel_turn_duration_seconds_bucket{mode="live",le="0.05"} 1');
  expect(metrics).toContain('wakeel_turn_duration_seconds_bucket{mode="live",le="+Inf"} 2');
  expect(metrics).toContain('wakeel_turn_duration_seconds_count{mode="live"} 2');
  expect(() => countMetric("wakeel_llm_errors_total", { provider: "secret key" })).toThrow();
});
