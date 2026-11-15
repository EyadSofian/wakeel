import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// CLAUDE.md §9 and ADR-003: the engine never evaluates builder text. This guards against a
// "quick" fallback creeping in; the sandbox port is the only way to run an expression.
const FORBIDDEN = [
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /\bAsyncFunction\b/,
  /from\s+["'](node:)?vm["']/,
  /require\(\s*["'](node:)?vm["']\s*\)/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("engine source", () => {
  const files = sourceFiles(join(import.meta.dirname, "..", "src"));

  test("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)("%s has no eval, Function or vm", (file) => {
    const text = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
  });
});
