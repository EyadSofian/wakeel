import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { checkRepository, checkSource, maskComments } from "../lint-rules/tokens-only";

const rules = (path: string, source: string) => checkSource(path, source).map((f) => `${f.rule} ${f.match}`);
const TSX = "apps/studio/src/x/Example.tsx";
const CSS = "apps/studio/src/x/example.css";

describe("reports", () => {
  test.each([
    ['<div className="bg-[#fff]" />', ["arbitrary-value bg-[#fff]", "raw-colour #fff"]],
    ['<div className="p-[7px]" />', ["arbitrary-value p-[7px]"]],
    ['<div className="hover:w-[calc(100%-4px)]" />', ["arbitrary-value hover:w-[calc(100%-4px)]"]],
    ['<div className="-mt-[3px]" />', ["arbitrary-value -mt-[3px]"]],
    ['<div className="[mask-type:alpha]" />', ["arbitrary-value [mask-type:alpha]"]],
    ['const c = "#1a2B3c";', ["raw-colour #1a2B3c"]],
    ['const c = "#1a2b3c80";', ["raw-colour #1a2b3c80"]],
    ['const c = "rgb(0 0 0)";', ["raw-colour rgb("]],
    ["<p style={{ padding: 4 }} />", ["inline-style style={{ padding:"]],
    ["<p style={{ width: w, backgroundColor: x }} />", ["inline-style style={{ width: w, backgroundColor:"]],
    ["<motion.div transition={{ duration: 0.2 }} />", ["motion-value duration: 0"]],
    ['<motion.div transition={{ type: "spring", bounce: 0.3 }} />', ["motion-value bounce: 0"]],
    ["const t = { ease: [0.4, 0, 1, 1] };", ["motion-value ease: ["]],
  ])("%s", (source, expected) => {
    expect(rules(TSX, source)).toEqual(expected);
  });

  test.each([
    [".a { color: #fff; }", ["raw-colour #fff"]],
    [".a { background: oklch(0.5 0.1 20); }", ["raw-colour oklch("]],
    [".a { @apply p-[7px]; }", ["arbitrary-value p-[7px]"]],
    [".a { transition: opacity 200ms ease; }", ["motion-value transition: opacity 200ms"]],
  ])("CSS: %s", (source, expected) => {
    expect(rules(CSS, source)).toEqual(expected);
  });

  test("positions are 1-based line and column", () => {
    const [f] = checkSource(TSX, 'const a = 1;\nconst b = "x p-[7px]";\n');
    expect(f).toMatchObject({ line: 2, column: 14 });
  });
});

describe("does not report", () => {
  test.each([
    ['<div className="bg-surface text-secondary p-4 h-control rounded-md" />'],
    ["// see #123 and https://example.com/a#fff\nconst x = 1;"],
    ["/* bg-[#fff] in a comment */ const x = 1;"],
    ['const url = "https://example.com/path";'],
    ["const first = items[0];"],
    ["type Map = { [key: string]: number };"],
    ['const v = "var(--accent)";'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is sample JSX that contains a template literal.
    ["<p style={{ transform: `translateX(${x}px)` }} />"],
    ['import { duration } from "@wakeel/ui/motion";'],
  ])("%s", (source) => {
    expect(rules(TSX, source)).toEqual([]);
  });

  test("token files keep their values", () => {
    expect(rules("packages/ui/src/tokens.css", ":root { --accent: oklch(0.52 0.19 268); }")).toEqual([]);
    expect(rules("packages/ui/src/motion.ts", "export const d = { duration: 0.08 };")).toEqual([]);
  });

  test.each(["packages/ui/test/motion.test.ts", "apps/studio/tests/shots.spec.ts", "apps/studio/src/a.test.tsx"])(
    "test file %s is skipped",
    (path) => {
      expect(rules(path, 'const x = { duration: 0.2, color: "#fff" };')).toEqual([]);
    },
  );

  test("other file types are skipped", () => {
    expect(rules("apps/studio/README.md", "#fff p-[7px]")).toEqual([]);
  });
});

test("maskComments keeps positions and strings", () => {
  const src = 'a // c\nb = "//x" /* y\nz */ c';
  const masked = maskComments(src, ".ts");
  expect(masked.length).toBe(src.length);
  expect(masked).toBe('a     \nb = "//x"     \n     c');
});

describe("command line", () => {
  const script = fileURLToPath(new URL("../lint-rules/tokens-only.ts", import.meta.url));
  const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: "utf8" });

  test("fails on a file containing #fff or p-[7px] (acceptance 0.7)", () => {
    const root = mkdtempSync(join(tmpdir(), "tokens-only-"));
    try {
      for (const [path, body] of [
        ["apps/studio/src/a.tsx", 'export const A = () => <div className="text-[#fff]" />;\n'],
        ["packages/ui/src/b.tsx", 'export const B = () => <div className="p-[7px]" />;\n'],
      ] as const) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), body);
      }
      const result = run(root);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('apps/studio/src/a.tsx:1:46  tokens-only/raw-colour  "#fff"');
      expect(result.stdout).toContain('packages/ui/src/b.tsx:1:40  tokens-only/arbitrary-value  "p-[7px]"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the repository itself is clean", () => {
    expect(checkRepository(fileURLToPath(new URL("../..", import.meta.url)))).toEqual([]);
  });
});
