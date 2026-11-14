import { describe, expect, test } from "vitest";
import {
  canReplay,
  connectionStatus,
  DELIVERY_ERROR_CODES,
  deliveryStatus,
  describeError,
  EVENT_LABELS,
  EVENT_TYPES,
  webhookHost,
} from "./model";

describe("connections model", () => {
  test("every event type the API sends has a label", () => {
    expect(Object.keys(EVENT_LABELS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  test("statuses read as words with a tone", () => {
    expect(connectionStatus({ status: "disabled" })).toEqual({ label: "Turned off", tone: "error" });
    expect(deliveryStatus({ status: "dead" })).toEqual({ label: "Failed", tone: "error" });
    expect(deliveryStatus({ status: "failed" })).toEqual({ label: "Retrying", tone: "warning" });
  });

  test("error codes show the errors.ts title and fix", () => {
    expect(describeError("webhook_rejected")).toEqual({
      title: "The webhook endpoint did not accept the event",
      fix: "Make the endpoint answer with a 2xx status within 10 seconds. The response status is shown with the attempt.",
    });
    expect(describeError("something_new")).toEqual({ title: "something_new", fix: "" });
    expect(describeError(null)).toBeUndefined();
  });

  test("webhook host, and which deliveries can be replayed", () => {
    expect(webhookHost("https://hooks.example.com:8443/x?y=1")).toBe("hooks.example.com:8443");
    expect(webhookHost(null)).toBeUndefined();
    expect(canReplay({ status: "dead" })).toBe(true);
    expect(canReplay({ status: "pending" })).toBe(false);
  });
});

test("no delivery problem shows an unfilled {placeholder}", () => {
  for (const code of DELIVERY_ERROR_CODES) {
    const d = describeError(code);
    expect(`${d?.title} ${d?.fix}`, code).not.toMatch(/[{}]/);
  }
});
