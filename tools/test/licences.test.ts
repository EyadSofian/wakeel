import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { check, evaluate, installedPackages, noticesSection, replaceGenerated } from "../licences";

describe("evaluate (SPDX expressions)", () => {
  test.each(["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "OFL-1.1", "MPL-2.0", "(MIT OR Apache-2.0)", "MIT AND ISC"])(
    "%s is allowed",
    (expr) => {
      expect(evaluate(expr)).toEqual({ ok: true });
    },
  );

  test.each([
    ["AGPL-3.0-only", "denied"],
    ["AGPL-3.0-or-later", "denied"],
    ["GPL-3.0", "denied"],
    ["GPL-2.0+", "denied"],
    ["LGPL-2.1-only", "denied"],
    ["SSPL-1.0", "denied"],
    ["FSL-1.1-MIT", "denied"],
    ["BUSL-1.1", "denied"],
    ["MIT AND GPL-3.0", "denied"],
    ["(GPL-2.0 OR AGPL-3.0)", "denied"],
    ["GPL-2.0 WITH Classpath-exception-2.0", "denied"],
    ["WTFPL", "unknown"],
    ["UNLICENSED", "unknown"],
    ["SEE LICENSE IN LICENSE.md", "unknown"],
    ["(MIT", "unknown"],
    [undefined, "missing"],
    ["", "missing"],
  ])("%s is %s", (expr, why) => {
    expect(evaluate(expr)).toMatchObject({ ok: false, why });
  });

  test("an OR with one allowed alternative passes even if the other is copyleft", () => {
    expect(evaluate("(MIT OR GPL-3.0)")).toEqual({ ok: true });
  });
});

describe("check", () => {
  const pkg = (name: string, licence: string | undefined) => ({
    name,
    version: "1.0.0",
    licence,
    homepage: undefined,
    platformSpecific: false,
  });

  test("reports each failing package, and honours reviewed exceptions", () => {
    const packages = [pkg("ok", "MIT"), pkg("bad", "AGPL-3.0-only"), pkg("weird", "Custom-1.0")];
    expect(check(packages, []).map((p) => p.pkg.name)).toEqual(["bad", "weird"]);
    const excused = [{ package: "weird", version: "1.0.0", licence: "Custom-1.0", reason: "r", reviewedBy: "Eyad" }];
    expect(check(packages, excused).map((p) => p.pkg.name)).toEqual(["bad"]);
  });
});

describe("command line on a fake install", () => {
  const script = fileURLToPath(new URL("../licences.ts", import.meta.url));
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** Builds node_modules/.pnpm the way pnpm lays it out: real folders plus symlinks to dependencies. */
  const fakeInstall = (packages: { name: string; licence?: string; os?: string[] }[]) => {
    const root = mkdtempSync(join(tmpdir(), "licences-"));
    roots.push(root);
    for (const p of packages) {
      const dir = join(root, "node_modules", ".pnpm", `${p.name.replace("/", "+")}@1.0.0`, "node_modules", p.name);
      mkdirSync(dir, { recursive: true });
      const manifest: Record<string, unknown> = { name: p.name, version: "1.0.0" };
      if (p.licence) manifest["license"] = p.licence;
      if (p.os) manifest["os"] = p.os;
      writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    }
    // A dependency symlink inside another package's folder must not be counted twice.
    const first = packages[0];
    if (first) {
      const link = join(root, "node_modules", ".pnpm", `${first.name}@1.0.0`, "node_modules", "linked-dep");
      symlinkSync(join(root, "node_modules", ".pnpm", `${first.name}@1.0.0`, "node_modules", first.name), link);
    }
    return root;
  };
  const run = (root: string) => spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });

  test("passes when every licence is allowed", () => {
    const result = run(
      fakeInstall([
        { name: "left-pad", licence: "MIT" },
        { name: "@scope/lib", licence: "Apache-2.0" },
      ]),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All 2 third-party packages meet the licence policy.");
  });

  test("fails when a fake AGPL dependency is added (acceptance 0.10)", () => {
    const result = run(
      fakeInstall([
        { name: "left-pad", licence: "MIT" },
        { name: "evil-db", licence: "AGPL-3.0-only" },
      ]),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL  evil-db@1.0.0  AGPL-3.0-only  denied: AGPL-3.0-only");
  });

  test("fails on a package with no licence", () => {
    const result = run(fakeInstall([{ name: "mystery" }]));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing");
  });

  test("platform builds are checked but left out of the notices", () => {
    const root = fakeInstall([
      { name: "tool", licence: "MIT" },
      { name: "tool-darwin-arm64", licence: "MIT", os: ["darwin"] },
    ]);
    const packages = installedPackages(root);
    expect(packages.map((p) => p.name)).toEqual(["tool", "tool-darwin-arm64"]);
    expect(noticesSection(packages)).not.toContain("darwin");
  });
});

describe("notices", () => {
  test("only the generated section is replaced", () => {
    const doc = "intro\n<!-- BEGIN GENERATED: pnpm licences --write -->\nold\n<!-- END GENERATED -->\noutro\n";
    const next = replaceGenerated(doc, "<!-- BEGIN GENERATED: pnpm licences --write -->\nnew\n<!-- END GENERATED -->");
    expect(next).toBe("intro\n<!-- BEGIN GENERATED: pnpm licences --write -->\nnew\n<!-- END GENERATED -->\noutro\n");
  });

  test("the repository passes and its notices are current", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../licences.ts", import.meta.url))], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.stdout).toMatch(/All \d+ third-party packages meet the licence policy\./);
    expect(result.status).toBe(0);
  });
});
