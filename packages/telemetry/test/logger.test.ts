import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createLogger } from "../src/index";

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  return { lines, destination };
};

const CANARY = "canary-secret-91f2";

describe("createLogger", () => {
  test("writes JSON with service, ISO time and a level label", () => {
    const { lines, destination } = capture();
    createLogger({ service: "api", destination }).info({ requestId: "req_x" }, "started");
    expect(lines[0]).toMatchObject({ service: "api", level: "info", msg: "started", requestId: "req_x" });
    expect(String(lines[0]?.["time"])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("respects the level", () => {
    const { lines, destination } = capture();
    const log = createLogger({ service: "worker", level: "warn", destination });
    log.info("hidden");
    log.warn("shown");
    expect(lines.map((l) => l["msg"])).toEqual(["shown"]);
  });

  test.each([
    ["authorization header", { req: { headers: { authorization: `Bearer ${CANARY}` } } }],
    ["cookie header", { req: { headers: { cookie: `session=${CANARY}` } } }],
    ["password field", { user: { password: CANARY } }],
    ["api key field", { key: { apiKey: CANARY } }],
    ["token field", { session: { token: CANARY } }],
  ])("censors the %s", (_name, payload) => {
    const { lines, destination } = capture();
    createLogger({ service: "api", destination }).info(payload, "request");
    expect(JSON.stringify(lines)).not.toContain(CANARY);
    expect(JSON.stringify(lines)).toContain("[redacted]");
  });
});
