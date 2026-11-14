import { describe, expect, test } from "vitest";
import { CreateConnectionRequest, UpdateConnectionRequest, webhookUrlProblem } from "../src/index";

/** Task 5.5 (ADR-030 §4): which webhook URLs the Studio accepts. Egress checks again on every send. */

describe("webhookUrlProblem", () => {
  test.each([
    "https://hooks.example.com/wakeel",
    "https://chatwoot.engosoft.com:8443/bridge?x=1",
    "https://xn--mgbh0fb.example/hook",
    "https://8.8.8.8/hook",
    "https://[2001:4860:4860::8888]/hook",
  ])("accepts %s", (url) => {
    expect(webhookUrlProblem(url)).toBeUndefined();
  });

  test.each([
    ["http://hooks.example.com", "Use an https address"],
    ["ftp://hooks.example.com", "Use an https address"],
    ["hooks.example.com/x", "Enter a full address, starting with https://"],
    ["https://user:pw@hooks.example.com", "Remove the user name and password from the address"],
    ["https://localhost/hook", "Use a public address, not localhost"],
    ["https://api.localhost/hook", "Use a public address, not localhost"],
    ["https://127.0.0.1/hook", "Use a public address, not a private or local one"],
    ["https://10.0.0.5/hook", "Use a public address, not a private or local one"],
    ["https://172.20.1.1/hook", "Use a public address, not a private or local one"],
    ["https://192.168.1.10/hook", "Use a public address, not a private or local one"],
    ["https://169.254.169.254/latest", "Use a public address, not a private or local one"],
    ["https://100.64.0.1/hook", "Use a public address, not a private or local one"],
    ["https://0.0.0.0/hook", "Use a public address, not a private or local one"],
    ["https://2130706433/hook", "Use a public address, not a private or local one"],
    ["https://0x7f.0.0.1/hook", "Use a public address, not a private or local one"],
    ["https://[::1]/hook", "Use a public address, not a private or local one"],
    ["https://[fd00::1]/hook", "Use a public address, not a private or local one"],
    ["https://[fe80::1]/hook", "Use a public address, not a private or local one"],
    ["https://[::ffff:127.0.0.1]/hook", "Use a public address, not a private or local one"],
    ["https://[::ffff:10.1.2.3]/hook", "Use a public address, not a private or local one"],
  ])("refuses %s", (url, problem) => {
    expect(webhookUrlProblem(url)).toBe(problem);
  });

  test("refuses an address over 2048 characters", () => {
    expect(webhookUrlProblem(`https://example.com/${"a".repeat(2_040)}`)).toBe(
      "Use an address of at most 2048 characters",
    );
  });
});

describe("connection requests", () => {
  test("create defaults to every event, without duplicates when they are listed", () => {
    expect(CreateConnectionRequest.parse({ name: "Chatwoot", target: "production" }).subscribedEvents).toHaveLength(6);
    expect(
      CreateConnectionRequest.parse({
        name: "Chatwoot",
        target: "draft",
        subscribedEvents: ["typing", "typing", "message.created"],
      }).subscribedEvents,
    ).toEqual(["typing", "message.created"]);
  });

  test("update needs at least one field, and null removes the webhook", () => {
    expect(UpdateConnectionRequest.safeParse({}).success).toBe(false);
    expect(UpdateConnectionRequest.parse({ webhookUrl: null })).toEqual({ webhookUrl: null });
    expect(UpdateConnectionRequest.safeParse({ webhookUrl: "https://10.0.0.1" }).success).toBe(false);
    expect(UpdateConnectionRequest.safeParse({ status: "disabled" }).success).toBe(false);
  });
});
