import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mintCapabilityToken } from "@wakeel/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../src/pool";
import { resultOf, runWithHost } from "./host";

/**
 * Build plan 3.3: "`fetch` to a private address is blocked", through the real egress service started
 * as its own process, exactly as in production. Nothing here leaves the machine: every target is
 * private, loopback, link-local or a metadata address, and egress must refuse each before dialling.
 */

const EGRESS_TOKEN = "sandbox-test-egress-token-0123456789abc";
const CAPABILITY_KEY = "sandbox-test-capability-key-0123456789ab";
const WORKSPACE = "ws_01jcqz5p6q7r8s9t0v1w2x3y4z";

let egress: ChildProcess;
let pool: SandboxPool;
let egressLog = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

beforeAll(async () => {
  const port = await freePort();
  const egressDir = fileURLToPath(new URL("../../egress/", import.meta.url));
  egress = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: egressDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      EGRESS_TOKEN,
      EGRESS_CAPABILITY_KEY: CAPABILITY_KEY,
      EGRESS_HOST: "127.0.0.1",
      EGRESS_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      egressLog += chunk.toString("utf8");
      if (egressLog.includes("egress listening")) resolve();
    };
    egress.stdout?.on("data", onData);
    egress.stderr?.on("data", onData);
    egress.once("exit", (code) => reject(new Error(`egress exited with ${code}: ${egressLog}`)));
  });
  await ready;
  pool = new SandboxPool({ size: 1, egressUrl: `http://127.0.0.1:${port}` });
  await pool.start();
}, 30_000);

afterAll(async () => {
  await pool?.close();
  egress?.kill("SIGTERM");
});

const capability = () =>
  mintCapabilityToken(CAPABILITY_KEY, { ws: WORKSPACE, exec: "exec_e2e", exp: Math.floor(Date.now() / 1000) + 60 });

describe("fetch through the real egress service", () => {
  test.each([
    ["loopback", "http://127.0.0.1:1/"],
    ["loopback by name", "http://localhost/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["private 10/8", "http://10.0.0.1/"],
    ["private 192.168/16", "http://192.168.1.1/admin"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["decimal loopback", "http://2130706433/"],
    ["hex loopback", "http://0x7f000001/"],
  ])("%s is blocked", async (_name, url) => {
    const r = await runWithHost(
      pool,
      `try { await fetch(${JSON.stringify(url)}); return "reached"; } catch (e) { return e.code; }`,
      { capabilityToken: await capability(), timeoutMs: 5_000 },
    );
    expect(resultOf(r.outcome).value).toBe("fetch_blocked");
  });

  test("egress logs the workspace from the token, and never the token", async () => {
    const token = await capability();
    await runWithHost(pool, "try { await fetch('http://10.0.0.2/'); } catch {}", {
      capabilityToken: token,
      timeoutMs: 5_000,
    });
    expect(egressLog).toContain(WORKSPACE);
    expect(egressLog).not.toContain(token);
  });

  test("a token for another key is refused by egress", async () => {
    const forged = await mintCapabilityToken("forged-capability-key-0123456789abcdef", {
      ws: WORKSPACE,
      exec: "exec_e2e",
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const r = await runWithHost(pool, "try { await fetch('http://10.0.0.3/'); } catch (e) { return e.code; }", {
      capabilityToken: forged,
      timeoutMs: 5_000,
    });
    expect(resultOf(r.outcome).value).toBe("fetch_failed");
  });
});
