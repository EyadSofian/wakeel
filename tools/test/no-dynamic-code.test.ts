import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { checkRepository, checkSource } from "../lint-rules/no-dynamic-code";

const rules = (source: string, path = "apps/sandbox/src/x.ts") =>
  checkSource(path, source).map((f) => `${f.rule} ${f.match}`);

describe("reports", () => {
  test.each([
    ["eval('1 + 1');", ["eval eval"]],
    ["const e = eval; e('x');", ["eval eval"]],
    ["globalThis.eval('x');", ["eval globalThis.eval"]],
    ["window['eval']('x');", ['eval window["eval"]']],
    ["new Function('return 1');", ["function Function"]],
    ["Function('return 1')();", ["function Function"]],
    ["const F = Function; new F('x');", ["function Function"]],
    ["globalThis.Function('x');", ["function globalThis.Function"]],
    ["const AsyncFunction = (async () => {}).constructor;", ["function AsyncFunction"]],
    ["(async () => {}).constructor('return 1');", ["function .constructor("]],
    ["import vm from 'node:vm';", ["vm node:vm"]],
    ["import { runInNewContext } from 'vm';", ["vm vm"]],
    ["export { Script } from 'node:vm';", ["vm node:vm"]],
    ["const vm = require('vm');", ["vm vm"]],
    ["const vm = await import('node:vm');", ["vm node:vm"]],
    ["process.binding('contextify');", ["vm process.binding"]],
    ["setTimeout('alert(1)', 10);", ["string-timer setTimeout"]],
    ["setInterval(`tick()`, 10);", ["string-timer setInterval"]],
  ])("%s", (source, expected) => {
    expect(rules(source)).toEqual(expected);
  });

  test("tsx files and JavaScript files are checked too", () => {
    expect(rules("export const A = () => <p>{eval('1')}</p>;", "apps/studio/src/A.tsx")).toEqual(["eval eval"]);
    expect(rules("module.exports = new Function('x');", "tools/x.cjs")).toEqual(["function Function"]);
  });

  test("findings carry the line and column", () => {
    expect(checkSource("apps/sandbox/src/x.ts", "const a = 1;\n  eval('x');")).toMatchObject([
      { path: "apps/sandbox/src/x.ts", line: 2, column: 3, rule: "eval" },
    ]);
  });
});

describe("allows", () => {
  test.each([
    ["QuickJS methods named eval…", "context.evalCode('1'); runtime.executePendingJobs();"],
    ["a variable named vm", "const vm = QuickJS.newContext(); vm.dispose();"],
    ["text that mentions the words", "const s = 'eval Function vm new Function(x)'; // eval('x')"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text containing a template literal.
    ["template text", "const t = `eval(${name}) and new Function`;"],
    ["an object key", "const queues = { eval: 1, Function: 2 }; queues.eval;"],
    ["a method on another object", "evals.eval('x'); tools.Function;"],
    ["the Function type", "type Fn = Function; const f: Function = () => 1; interface I { cb: Function }"],
    ["a class constructor", "class A { constructor() {} } new this.constructor();"],
    ["a timer with a callback", "setTimeout(() => run(), 10);"],
    ["typeof checks", "if (typeof x === 'function') {}"],
    ["guest source sent to the sandbox", "await pool.exec({ source: \"eval('1'); new Function('x')\" });"],
  ])("%s", (_name, source) => {
    expect(rules(source)).toEqual([]);
  });
});

describe("repository", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  test("the repository is clean", () => {
    expect(checkRepository(root)).toEqual([]);
  });

  test("the CLI fails the build on a finding and passes a clean tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-dynamic-code-"));
    try {
      mkdirSync(join(dir, "apps", "sandbox", "src"), { recursive: true });
      writeFileSync(join(dir, "apps", "sandbox", "src", "ok.ts"), "export const a = 1;\n");
      const cli = join(root, "tools", "lint-rules", "no-dynamic-code.ts");
      const clean = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
      expect(clean.status).toBe(0);

      writeFileSync(join(dir, "apps", "sandbox", "src", "bad.ts"), "export const run = (s: string) => eval(s);\n");
      const dirty = spawnSync(process.execPath, [cli, dir], { encoding: "utf8" });
      expect(dirty.status).toBe(1);
      expect(dirty.stderr).toContain("apps/sandbox/src/bad.ts:1:");
      expect(dirty.stderr).toContain("eval");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
