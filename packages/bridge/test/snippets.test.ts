import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer } from "testcontainers";
import { describe, expect, test } from "vitest";
import { signatureHeader } from "../src/signing";
import {
  curlExample,
  SIGNATURE_CHECK_NODE,
  SIGNATURE_CHECK_PHP,
  SIGNATURE_CHECK_PYTHON,
  SIGNATURE_CHECKS,
} from "../src/snippets";

/**
 * Task 5.5: the signature checks the Setup tab offers to copy are run, in their own language,
 * against signatures from the platform's signer. A snippet that only looks right is not enough.
 */

const NOW = 1_794_567_890;
const CURRENT = "whsec_current_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PREVIOUS = "whsec_previous_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BODY = JSON.stringify({ type: "message.created", data: { text: "طلبك اتشحن امبارح 📦" } });

interface Case {
  name: string;
  header: string;
  body: string;
  secret: string;
  now: number;
  expected: boolean;
}

const signed = signatureHeader([CURRENT], NOW, BODY);
const rotating = signatureHeader([CURRENT, PREVIOUS], NOW, BODY);
const CASES: Case[] = [
  { name: "valid", header: signed, body: BODY, secret: CURRENT, now: NOW, expected: true },
  { name: "rotation, old secret", header: rotating, body: BODY, secret: PREVIOUS, now: NOW, expected: true },
  { name: "rotation, new secret", header: rotating, body: BODY, secret: CURRENT, now: NOW, expected: true },
  { name: "within tolerance", header: signed, body: BODY, secret: CURRENT, now: NOW + 299, expected: true },
  { name: "tampered body", header: signed, body: `${BODY} `, secret: CURRENT, now: NOW, expected: false },
  { name: "old timestamp", header: signed, body: BODY, secret: CURRENT, now: NOW + 301, expected: false },
  { name: "wrong secret", header: signed, body: BODY, secret: PREVIOUS, now: NOW, expected: false },
  { name: "malformed header", header: "v1=abc", body: BODY, secret: CURRENT, now: NOW, expected: false },
  { name: "empty header", header: "", body: BODY, secret: CURRENT, now: NOW, expected: false },
];
const casesJson = JSON.stringify(
  CASES.map(({ expected: _e, name: _n, ...c }) => ({ ...c, body: Buffer.from(c.body).toString("base64") })),
);

const workdir = () => mkdtempSync(join(tmpdir(), "wakeel-snippets-"));
const expectAll = (results: boolean[]) =>
  expect(Object.fromEntries(CASES.map((c, i) => [c.name, results[i]]))).toEqual(
    Object.fromEntries(CASES.map((c) => [c.name, c.expected])),
  );

describe("signature checks", () => {
  test("the three languages are offered, in this order", () => {
    expect(SIGNATURE_CHECKS.map((c) => c.label)).toEqual(["Node", "Python", "PHP"]);
  });

  test("Node", () => {
    const dir = workdir();
    writeFileSync(join(dir, "verify.mjs"), SIGNATURE_CHECK_NODE);
    writeFileSync(join(dir, "cases.json"), casesJson);
    writeFileSync(
      join(dir, "run.mjs"),
      `import { readFileSync } from "node:fs";
import { verifyWakeel } from "./verify.mjs";
const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
console.log(JSON.stringify(cases.map((c) => verifyWakeel(c.header, Buffer.from(c.body, "base64"), c.secret, c.now))));`,
    );
    expectAll(JSON.parse(execFileSync(process.execPath, [join(dir, "run.mjs")], { encoding: "utf8" })));
  });

  test("Python", () => {
    const dir = workdir();
    writeFileSync(join(dir, "verify.py"), SIGNATURE_CHECK_PYTHON);
    writeFileSync(join(dir, "cases.json"), casesJson);
    writeFileSync(
      join(dir, "run.py"),
      `import base64, json, sys
sys.path.insert(0, sys.argv[1])
from verify import verify_wakeel
cases = json.load(open(sys.argv[1] + "/cases.json"))
print(json.dumps([verify_wakeel(c["header"], base64.b64decode(c["body"]), c["secret"], c["now"]) for c in cases]))`,
    );
    expectAll(JSON.parse(execFileSync("python3", ["-I", join(dir, "run.py"), dir], { encoding: "utf8" })));
  });

  test("PHP", async () => {
    const container = await new GenericContainer("php:8.3.14-cli-alpine3.20")
      .withCopyContentToContainer([
        { content: SIGNATURE_CHECK_PHP, target: "/app/verify.php" },
        { content: casesJson, target: "/app/cases.json" },
        {
          content: `<?php
require '/app/verify.php';
$cases = json_decode(file_get_contents('/app/cases.json'), true);
echo json_encode(array_map(fn($c) => verify_wakeel($c['header'], base64_decode($c['body']), $c['secret'], $c['now']), $cases));`,
          target: "/app/run.php",
        },
      ])
      .withCommand(["sleep", "300"])
      .start();
    try {
      const { output, exitCode } = await container.exec(["php", "/app/run.php"]);
      expect(exitCode, output).toBe(0);
      expectAll(JSON.parse(output));
    } finally {
      await container.stop();
    }
  }, 180_000);
});

describe("curlExample", () => {
  test("calls sendMessage with wait on the given API, with the key from the environment", () => {
    const curl = curlExample({ apiBaseUrl: "https://api.example.com/" });
    expect(curl).toContain('"https://api.example.com/v1/bridge/conversations/chat-1/messages?wait=20"');
    expect(curl).toContain("Bearer $WAKEEL_BRIDGE_KEY");
    expect(curl).not.toContain("wk_bridge_");
  });
});
