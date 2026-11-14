import { randomBytes } from "node:crypto";
import type { BotManifest } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Browser, STUDIO, type Stack, signUp, startStack } from "./stack";

/**
 * Task 7.3 through the api (ADR-037): values per environment; a secret is never returned; builders
 * set settings but not secrets; undeclared keys are refused; audit entries carry no value.
 */
let stack: Stack;
const CANARY = "canary-api-4c2f81e7";

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.stop();
});

const slug = () => `c-${randomBytes(4).toString("hex")}`;

/** A workspace with a bot declaring SHOP_URL (setting) and SHOP_TOKEN (secret), and a builder member. */
async function setup() {
  const owner = await signUp(stack.app);
  const ws = (await owner.send("POST", "/v1/workspaces", { name: "Config", slug: slug() })).json().id as string;
  const botId = (await owner.send("POST", `/v1/workspaces/${ws}/bots`, { name: "متجر", slug: slug() })).json()
    .id as string;
  const base = `/v1/workspaces/${ws}/bots/${botId}`;
  const res = await owner.get(`${base}/docs/manifest/manifest`);
  const manifest = res.json().doc as BotManifest;
  const saved = await stack.app.inject({
    method: "PUT",
    url: `${base}/docs/manifest/manifest`,
    headers: {
      cookie: owner.cookie,
      origin: STUDIO,
      "x-csrf-token": owner.csrf,
      "if-match": res.headers.etag as string,
    },
    payload: {
      doc: {
        ...manifest,
        configVars: [
          { key: "SHOP_URL", secret: false, description: "عنوان المتجر" },
          { key: "SHOP_TOKEN", secret: true },
        ],
      },
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const builder = await signUp(stack.app);
  const inv = await owner.send("POST", `/v1/workspaces/${ws}/invitations`, { email: builder.email, role: "builder" });
  const token = new URL(inv.json().acceptUrl).pathname.split("/").pop();
  expect((await builder.send("POST", "/v1/invitations/accept", { token })).statusCode).toBe(200);
  return { owner, builder, ws, base };
}

const put = (b: Browser, url: string, value: string) => b.send("PUT", url, { value });

describe("config variables", () => {
  test("draft and production values differ; the list shows settings and never a secret", async () => {
    const { owner, base, ws } = await setup();
    expect((await put(owner, `${base}/config/draft/SHOP_URL`, "https://staging.shop.example")).statusCode).toBe(204);
    expect((await put(owner, `${base}/config/production/SHOP_URL`, "https://shop.example")).statusCode).toBe(204);
    expect((await put(owner, `${base}/config/production/SHOP_TOKEN`, CANARY)).statusCode).toBe(204);
    const list = await owner.get(`${base}/config`);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(CANARY);
    const byKey = Object.fromEntries(list.json().data.map((v: { key: string }) => [v.key, v]));
    expect(byKey.SHOP_URL).toMatchObject({
      secret: false,
      description: "عنوان المتجر",
      draft: { set: true, value: "https://staging.shop.example" },
      production: { set: true, value: "https://shop.example" },
    });
    expect(byKey.SHOP_TOKEN).toMatchObject({
      secret: true,
      draft: { set: false, value: null },
      production: { set: true, value: null },
    });
    const auditLog = await owner.get(`/v1/workspaces/${ws}/audit-log?limit=200`);
    expect(auditLog.body).not.toContain(CANARY);
    expect(auditLog.json().data.filter((e: { action: string }) => e.action === "config_var.set")).toHaveLength(3);
  });

  test("a builder sets settings but not secrets", async () => {
    const { builder, base } = await setup();
    expect((await put(builder, `${base}/config/draft/SHOP_URL`, "https://x.example")).statusCode).toBe(204);
    expect((await put(builder, `${base}/config/draft/SHOP_TOKEN`, CANARY)).statusCode).toBe(403);
    expect((await builder.send("DELETE", `${base}/config/draft/SHOP_URL`)).statusCode).toBe(204);
  });

  test("an undeclared key is refused; a bad environment or key is a 400", async () => {
    const { owner, base } = await setup();
    const res = await put(owner, `${base}/config/draft/OTHER_KEY`, "x");
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0]).toMatchObject({ path: "key", code: "not_declared" });
    expect((await put(owner, `${base}/config/staging/SHOP_URL`, "x")).statusCode).toBe(400);
    expect((await put(owner, `${base}/config/draft/shop_url`, "x")).statusCode).toBe(400);
  });

  test("two tenants: another workspace cannot read or set values", async () => {
    const { owner, base } = await setup();
    await put(owner, `${base}/config/production/SHOP_TOKEN`, CANARY);
    const other = await signUp(stack.app);
    const ows = (await other.send("POST", "/v1/workspaces", { name: "Other", slug: slug() })).json().id as string;
    const botId = base.split("/").pop();
    const foreign = `/v1/workspaces/${ows}/bots/${botId}/config`;
    expect((await other.get(foreign)).statusCode).toBe(404);
    expect((await put(other, `${foreign}/draft/SHOP_URL`, "x")).statusCode).toBe(404);
    expect((await other.get(`${base}/config`)).statusCode).toBe(404);
  });
});
