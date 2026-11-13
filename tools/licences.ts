/**
 * `pnpm licences` (build plan 0.10; CLAUDE.md §9 Licences). Reads every installed third-party package
 * from node_modules/.pnpm, evaluates its SPDX licence expression against the policy below, and fails
 * on anything denied, unknown or missing unless it is listed, with a reason, in
 * tools/licence-exceptions.json. It also keeps the generated part of THIRD_PARTY_NOTICES.md current.
 *
 *   node tools/licences.ts                 check, and check THIRD_PARTY_NOTICES.md is current
 *   node tools/licences.ts --write         check, and rewrite the generated part of the notices
 *   node tools/licences.ts --root <dir>    check another tree (tests)
 */
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Permissive or, for MPL-2.0, file-level copyleft that only binds changes to its own files. */
export const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "CC-BY-4.0",
  // Fonts (IBM Plex, design system §2.2).
  "OFL-1.1",
  // lightningcss, used unmodified at build time by Tailwind and Vite.
  "MPL-2.0",
]);

/** Licences the project must never depend on. Matched by prefix, so GPL-3.0-only and AGPL-3.0-or-later count. */
export const DENIED_PREFIXES = ["GPL", "AGPL", "LGPL", "SSPL", "FSL", "BUSL", "Elastic", "Commons-Clause", "CC-BY-NC"];

export interface InstalledPackage {
  name: string;
  version: string;
  licence: string | undefined;
  homepage: string | undefined;
  /**
   * Declares `os`, `cpu` or `libc`: a platform build (e.g. @esbuild/darwin-arm64) that pnpm installs
   * only on matching machines. Its licence is checked, but the notices leave it out so the file is the
   * same on every machine; the package it belongs to is listed.
   */
  platformSpecific: boolean;
}

export interface Exception {
  package: string;
  version: string;
  licence: string;
  reason: string;
  reviewedBy: string;
}

export type Verdict = { ok: true } | { ok: false; why: "denied" | "unknown" | "missing"; detail: string };

/**
 * Evaluates an SPDX expression: `A OR B` passes if either passes, `A AND B` only if both do,
 * parentheses group, `WITH <exception>` is judged by its base licence. A denied licence on a path that
 * must hold makes the whole expression denied.
 */
export function evaluate(expression: string | undefined): Verdict {
  if (expression === undefined || expression.trim() === "")
    return { ok: false, why: "missing", detail: "no licence field" };
  const tokens = expression
    .replace(/[()]/g, (p) => ` ${p} `)
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;

  type Node = { kind: "id"; id: string } | { kind: "or" | "and"; left: Node; right: Node };
  const primary = (): Node => {
    const t = tokens[i++];
    if (t === undefined) throw new Error("unexpected end");
    if (t === "(") {
      const node = or();
      if (tokens[i++] !== ")") throw new Error("missing )");
      return node;
    }
    if (tokens[i]?.toUpperCase() === "WITH") i += 2;
    return { kind: "id", id: t.replace(/\+$/, "") };
  };
  const and = (): Node => {
    let left = primary();
    while (tokens[i]?.toUpperCase() === "AND") {
      i++;
      left = { kind: "and", left, right: primary() };
    }
    return left;
  };
  const or = (): Node => {
    let left = and();
    while (tokens[i]?.toUpperCase() === "OR") {
      i++;
      left = { kind: "or", left, right: and() };
    }
    return left;
  };

  let tree: Node;
  try {
    tree = or();
    if (i !== tokens.length) throw new Error("trailing tokens");
  } catch {
    return { ok: false, why: "unknown", detail: `cannot parse "${expression}"` };
  }

  const judge = (node: Node): Verdict => {
    if (node.kind === "id") {
      if (DENIED_PREFIXES.some((p) => node.id.toUpperCase().startsWith(p.toUpperCase()))) {
        return { ok: false, why: "denied", detail: node.id };
      }
      return ALLOWED.has(node.id) ? { ok: true } : { ok: false, why: "unknown", detail: node.id };
    }
    const l = judge(node.left);
    const r = judge(node.right);
    if (node.kind === "or") {
      if (l.ok || r.ok) return { ok: true };
      return l.why === "denied" ? l : r;
    }
    if (!l.ok) return l;
    return r;
  };
  return judge(tree);
}

function licenceOf(pkg: Record<string, unknown>): string | undefined {
  const l = pkg["license"] ?? pkg["licenses"];
  if (typeof l === "string") return l;
  if (Array.isArray(l)) {
    const types = l.map((x) =>
      typeof x === "object" && x && "type" in x ? String((x as { type: unknown }).type) : String(x),
    );
    return types.length > 1 ? `(${types.join(" OR ")})` : types[0];
  }
  if (l && typeof l === "object" && "type" in l) return String((l as { type: unknown }).type);
  return undefined;
}

/** Every package physically installed under node_modules/.pnpm (symlinks are links to others). */
export function installedPackages(root: string): InstalledPackage[] {
  const store = join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) throw new Error(`${store} not found. Run pnpm install first.`);
  const found = new Map<string, InstalledPackage>();
  for (const entry of readdirSync(store)) {
    const modules = join(store, entry, "node_modules");
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      const dirs = name.startsWith("@")
        ? readdirSync(join(modules, name)).map((s) => join(modules, name, s))
        : [join(modules, name)];
      for (const dir of dirs) {
        if (lstatSync(dir).isSymbolicLink()) continue;
        const file = join(dir, "package.json");
        if (!existsSync(file)) continue;
        const pkg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        const homepage = typeof pkg["homepage"] === "string" ? pkg["homepage"] : undefined;
        const p: InstalledPackage = {
          name: String(pkg["name"]),
          version: String(pkg["version"]),
          licence: licenceOf(pkg),
          homepage,
          platformSpecific: ["os", "cpu", "libc"].some((k) => k in pkg),
        };
        found.set(`${p.name}@${p.version}`, p);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export interface Problem {
  pkg: InstalledPackage;
  verdict: Exclude<Verdict, { ok: true }>;
}

export function check(packages: InstalledPackage[], exceptions: Exception[]): Problem[] {
  const excused = new Set(exceptions.map((e) => `${e.package}@${e.version}`));
  const problems: Problem[] = [];
  for (const pkg of packages) {
    const verdict = evaluate(pkg.licence);
    if (!verdict.ok && !excused.has(`${pkg.name}@${pkg.version}`)) problems.push({ pkg, verdict });
  }
  return problems;
}

const BEGIN = "<!-- BEGIN GENERATED: pnpm licences --write -->";
const END = "<!-- END GENERATED -->";

/** The generated part of THIRD_PARTY_NOTICES.md: every installed package, grouped by licence. */
export function noticesSection(all: InstalledPackage[]): string {
  const packages = all.filter((p) => !p.platformSpecific);
  const groups = new Map<string, InstalledPackage[]>();
  for (const p of packages) {
    const key = p.licence ?? "(none)";
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const lines = [
    BEGIN,
    "",
    `${packages.length} packages installed by \`pnpm install\` (runtime and development), not counting platform builds.`,
    "",
  ];
  for (const [licence, list] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push(`### ${licence} (${list.length})`, "");
    for (const p of list) lines.push(`- ${p.name} ${p.version}${p.homepage ? ` — ${p.homepage}` : ""}`);
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n");
}

export function replaceGenerated(document: string, section: string): string {
  const start = document.indexOf(BEGIN);
  const end = document.indexOf(END);
  if (start === -1 || end === -1) throw new Error("THIRD_PARTY_NOTICES.md has no generated section markers");
  return `${document.slice(0, start)}${section}${document.slice(end + END.length)}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? (args[rootIndex + 1] ?? ".") : fileURLToPath(new URL("..", import.meta.url));
  const write = args.includes("--write");

  const exceptionsFile = join(root, "tools", "licence-exceptions.json");
  const exceptions: Exception[] = existsSync(exceptionsFile) ? JSON.parse(readFileSync(exceptionsFile, "utf8")) : [];
  const packages = installedPackages(root);
  const problems = check(packages, exceptions);

  for (const { pkg, verdict } of problems) {
    process.stdout.write(
      `FAIL  ${pkg.name}@${pkg.version}  ${pkg.licence ?? "(no licence)"}  ${verdict.why}: ${verdict.detail}\n`,
    );
  }

  let noticesStale = false;
  const noticesFile = join(root, "THIRD_PARTY_NOTICES.md");
  if (existsSync(noticesFile)) {
    const current = readFileSync(noticesFile, "utf8");
    const next = replaceGenerated(current, noticesSection(packages));
    if (write) writeFileSync(noticesFile, next);
    else if (next !== current) noticesStale = true;
  }

  if (problems.length > 0) {
    process.stdout.write(
      `\n${problems.length} package(s) fail the licence policy. Remove the dependency, or add it to tools/licence-exceptions.json with a reason after review.\n`,
    );
  }
  if (noticesStale) {
    process.stdout.write("THIRD_PARTY_NOTICES.md is out of date. Run `pnpm licences --write` and commit it.\n");
  }
  if (problems.length > 0 || noticesStale) process.exitCode = 1;
  else process.stdout.write(`All ${packages.length} third-party packages meet the licence policy.\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
