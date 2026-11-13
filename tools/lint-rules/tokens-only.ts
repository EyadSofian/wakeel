/**
 * tokens-only (design system §2, CLAUDE.md §6 Studio rules). Biome cannot see inside Tailwind class
 * strings, so this runs as part of `pnpm lint`. It rejects, in apps/studio and packages/ui:
 *
 *   raw-colour       hex colours and colour functions (rgb, hsl, oklch, …)
 *   arbitrary-value  Tailwind arbitrary values and properties: p-[7px], bg-[#fff], [mask-type:alpha]
 *   inline-style     style={{ … }} setting colour, spacing or shadow
 *   motion-value     animation numbers (duration: 0.2, ease: [ … ], transition: 200ms …)
 *
 * Token files are exempt: packages/ui/src/tokens.css, theme.css (values) and motion.ts (motion).
 * So are tests (test/, tests/, *.test.*, *.spec.*): they assert the token values and computed
 * colours, and they never ship. Comments are ignored. Run: node tools/lint-rules/tokens-only.ts [root]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type RuleId = "raw-colour" | "arbitrary-value" | "inline-style" | "motion-value";

export interface Finding {
  path: string;
  line: number;
  column: number;
  rule: RuleId;
  match: string;
  message: string;
}

/** Folders checked, relative to the repository root. */
export const SCOPES = ["apps/studio", "packages/ui"];
const EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage", ".shots", ".motion", "test-results"]);

const EXEMPT: Record<string, RuleId[]> = {
  "packages/ui/src/tokens.css": ["raw-colour", "arbitrary-value", "motion-value"],
  "packages/ui/src/theme.css": ["raw-colour", "arbitrary-value"],
  "packages/ui/src/motion.ts": ["motion-value"],
};

interface Rule {
  id: RuleId;
  pattern: RegExp;
  appliesTo: (ext: string) => boolean;
  message: string;
}

const code = (ext: string) => ext !== ".css";
const any = () => true;

const RULES: Rule[] = [
  {
    id: "raw-colour",
    pattern: /(?<![\w&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
    appliesTo: any,
    message: "Raw colour. Use a colour token (bg-surface, text-secondary, var(--accent)).",
  },
  {
    id: "raw-colour",
    pattern: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g,
    appliesTo: any,
    message: "Raw colour function. Use a colour token; only tokens.css defines colours.",
  },
  {
    id: "arbitrary-value",
    pattern: /(?<![\w$])(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*:)*-?[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\[[^\]\s'"`]+\]/g,
    appliesTo: any,
    message: "Tailwind arbitrary value. Use a token utility (p-4, h-control, rounded-md) or add a token.",
  },
  {
    id: "arbitrary-value",
    pattern: /(?<![\w$])\[[a-z][a-z-]*:[^\]\s'"`]+\]/g,
    appliesTo: any,
    message: "Tailwind arbitrary property. Use a token utility or a class in packages/ui.",
  },
  {
    id: "inline-style",
    pattern:
      /style=\{\{[^}]*?\b(?:color|background\w*|border\w*Color|borderColor|outlineColor|fill|stroke|padding\w*|margin\w*|gap|rowGap|columnGap|boxShadow)\s*:/g,
    appliesTo: (ext) => ext === ".tsx",
    message: "Inline style for colour, spacing or shadow. Use token utilities instead.",
  },
  {
    id: "motion-value",
    pattern: /\b(?:duration|delay|stiffness|damping|mass|bounce|visualDuration|staggerChildren)\s*:\s*-?\d/g,
    appliesTo: code,
    message: "Animation value in a component. Use packages/ui/src/motion.ts (useMotionTokens).",
  },
  {
    id: "motion-value",
    pattern: /\bease\s*:\s*\[/g,
    appliesTo: code,
    message: "Easing curve in a component. Use ease.out from packages/ui/src/motion.ts.",
  },
  {
    id: "motion-value",
    pattern: /\b(?:transition|animation)(?:-duration|-delay)?\s*:[^;}]*?\d+(?:\.\d+)?m?s\b/g,
    appliesTo: (ext) => ext === ".css",
    message: "Animation timing in CSS. Use the motion tokens; animate only transform and opacity.",
  },
];

/**
 * Replaces comments with spaces (keeping line and column positions) so commented examples and
 * issue references (#123) are not reported. Strings are left intact: class names live in them.
 */
export function maskComments(source: string, ext: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const isCss = ext === ".css";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (!isCss && (ch === '"' || ch === "'" || ch === "`")) {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      i = j + 1;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (!isCss && ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (ext === ".html" && source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i);
      const stop = end === -1 ? source.length : end + 3;
      blank(i, stop);
      i = stop;
    } else {
      i++;
    }
  }
  return out.join("");
}

const TEST_FILE = /(^|\/)tests?\/|\.(test|spec)\.[a-z]+$/;

/** Findings for one file. `path` is relative to the repository root, with forward slashes. */
export function checkSource(path: string, source: string): Finding[] {
  const ext = extname(path);
  if (!EXTENSIONS.has(ext) || TEST_FILE.test(path)) return [];
  const exempt = EXEMPT[path] ?? [];
  const masked = maskComments(source, ext);
  const lineStarts = [0];
  for (let k = 0; k < masked.length; k++) if (masked[k] === "\n") lineStarts.push(k + 1);
  const position = (index: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Number.POSITIVE_INFINITY) <= index) line++;
    return { line: line + 1, column: index - (lineStarts[line] ?? 0) + 1 };
  };

  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (!rule.appliesTo(ext) || exempt.includes(rule.id)) continue;
    for (const m of masked.matchAll(rule.pattern)) {
      findings.push({ path, ...position(m.index ?? 0), rule: rule.id, match: m[0], message: rule.message });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(extname(name))) yield full;
  }
}

export function checkRepository(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const scope of SCOPES) {
    for (const file of walk(join(root, scope))) {
      const path = relative(root, file).split(sep).join("/");
      findings.push(...checkSource(path, readFileSync(file, "utf8")));
    }
  }
  return findings;
}

function main(): void {
  const root = process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url));
  const findings = checkRepository(root);
  for (const f of findings) {
    process.stdout.write(`${f.path}:${f.line}:${f.column}  tokens-only/${f.rule}  "${f.match}"  ${f.message}\n`);
  }
  if (findings.length > 0) {
    process.stdout.write(
      `\n${findings.length} tokens-only problem(s). Design system §2: components use tokens only.\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
