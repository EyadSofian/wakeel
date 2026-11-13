import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { TEST_POSTGRES_IMAGE } from "../src/testing/index";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const biome = fileURLToPath(new URL("../../../node_modules/.bin/biome", import.meta.url));

/**
 * Lints `source` as if it lived at `path` in this repository: copies biome.json into a temporary
 * folder, writes the file at the same relative path, and runs Biome there. (Biome's stdin mode does
 * not print diagnostics, so it cannot show which rule fired.)
 */
const lint = (path: string, source: string) => {
  const dir = mkdtempSync(join(tmpdir(), "wakeel-lint-"));
  try {
    copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
    const result = spawnSync(biome, ["lint", "--vcs-enabled=false", path], { cwd: dir, encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Architecture §2.1: a lint rule forbids importing the raw pool outside packages/db. The rule is
 * Biome's noRestrictedImports, configured in biome.json; this test proves it fires.
 */
describe("no raw database access outside packages/db", () => {
  test.each([
    ['import pg from "pg";', "pg"],
    ['import { Pool } from "pg";', "pg"],
    ['import { drizzle } from "drizzle-orm/node-postgres";', "drizzle-orm/node-postgres"],
    ['import postgres from "postgres";', "postgres"],
    ['import { Pool } from "pg-pool";', "pg-pool"],
  ])("%s is rejected in apps/", (source, module) => {
    const result = lint("apps/api/src/routes/example.ts", `${source}\n\nexport const x = 1;\n`);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("lint/style/noRestrictedImports");
    expect(result.output).toContain("Use withWorkspace from @wakeel/db");
    expect(result.output).toContain(`"${module}"`);
  });

  test("is rejected in other packages", () => {
    const result = lint("packages/engine/src/example.ts", 'import { Pool } from "pg";\n\nexport const x = Pool;\n');
    expect(result.status).not.toBe(0);
  });

  test("is allowed inside packages/db", () => {
    const result = lint("packages/db/src/example.ts", 'import { Pool } from "pg";\n\nexport const x = Pool;\n');
    expect(result.output).not.toContain("noRestrictedImports");
  });

  test("importing @wakeel/db is fine anywhere", () => {
    const result = lint(
      "apps/api/src/example.ts",
      'import { createDatabase } from "@wakeel/db";\n\nexport const x = createDatabase;\n',
    );
    expect(result.status).toBe(0);
  });
});

test("the test harness and docker-compose use the same Postgres image", () => {
  const compose = readFileSync(`${root}docker-compose.yml`, "utf8");
  expect(compose).toContain(`image: ${TEST_POSTGRES_IMAGE}`);
});
