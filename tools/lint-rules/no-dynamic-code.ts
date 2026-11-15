/**
 * no-dynamic-code (ADR-003 decision 5, CLAUDE.md §9). Tenant and model-written code runs only inside
 * apps/sandbox's QuickJS-WASM interpreter. There is no `vm`, `eval` or `Function` path anywhere in
 * the repository, in services, packages, tools or tests, and no "dev mode" fallback. It reports:
 *
 *   eval          the global eval, by name or through globalThis / window / global / self
 *   function      the Function constructor, AsyncFunction and friends, and `fn.constructor(…)`
 *   vm            importing or requiring `vm` / `node:vm`, and process.binding
 *   string-timer  setTimeout / setInterval given a string, which browsers evaluate
 *
 * It reads the TypeScript syntax tree, so strings, comments, object keys and types that merely
 * mention these names are fine: guest source sent to the sandbox is a string. Run:
 * node tools/lint-rules/no-dynamic-code.ts [root]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type RuleId = "eval" | "function" | "vm" | "string-timer";

export interface Finding {
  path: string;
  line: number;
  column: number;
  rule: RuleId;
  match: string;
  message: string;
}

/** Folders checked, relative to the repository root. */
export const SCOPES = ["apps", "packages", "tools", "examples"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  ".shots",
  ".motion",
  "test-results",
  "playwright-report",
]);

const MESSAGES: Record<RuleId, string> = {
  eval: "eval runs a string as code. Untrusted code runs only in apps/sandbox's QuickJS (ADR-003).",
  function:
    "The Function constructor runs a string as code. Untrusted code runs only in apps/sandbox's QuickJS (ADR-003).",
  vm: "node:vm is not a security boundary and there is no vm fallback (ADR-003). Use apps/sandbox.",
  "string-timer": "A timer given a string evaluates it as code. Pass a function.",
};

/** Names through which the global object is reachable. */
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);
const CONSTRUCTOR_NAMES = new Set(["AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"]);
const VM_MODULES = new Set(["vm", "node:vm"]);
const TIMERS = new Set(["setTimeout", "setInterval"]);

function scriptKind(ext: string): ts.ScriptKind {
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** True when `node` is only a name: a property, a member, a key, or the right side of `a.b`. */
function isNameOnly(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) && parent.propertyName === node) return true;
  return false;
}

/** True when `node` sits where only a type can: `f: Function`, `type F = Function`. */
function isTypePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isTypeReferenceNode(parent)) return true;
  if (ts.isExpressionWithTypeArguments(parent)) {
    const clause = parent.parent;
    return ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ImplementsKeyword;
  }
  return false;
}

const stringArgument = (node: ts.Expression | undefined) =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node));

const moduleName = (node: ts.Expression | undefined) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

/** Findings for one file. `path` is relative to the repository root, with forward slashes. */
export function checkSource(path: string, source: string): Finding[] {
  const ext = extname(path);
  if (!EXTENSIONS.has(ext)) return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(ext));
  const findings: Finding[] = [];
  const report = (node: ts.Node, rule: RuleId, match: string) => {
    const at = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.push({ path, line: at.line + 1, column: at.character + 1, rule, match, message: MESSAGES[rule] });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === "eval" && !isNameOnly(node)) report(node, "eval", "eval");
      if (node.text === "Function" && !isNameOnly(node) && !isTypePosition(node)) report(node, "function", "Function");
      if (CONSTRUCTOR_NAMES.has(node.text) && !isNameOnly(node)) report(node, "function", node.text);
    }

    // globalThis.eval, window.Function
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const target = node.expression.text;
      const name = node.name.text;
      if (GLOBAL_OBJECTS.has(target) && name === "eval") report(node, "eval", `${target}.eval`);
      if (GLOBAL_OBJECTS.has(target) && name === "Function") report(node, "function", `${target}.Function`);
      if (target === "process" && (name === "binding" || name === "_linkedBinding")) {
        report(node, "vm", `process.${name}`);
      }
    }

    // window["eval"], globalThis["Function"]
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text)
    ) {
      const key = moduleName(node.argumentExpression);
      if (key === "eval") report(node, "eval", `${node.expression.text}["eval"]`);
      if (key === "Function") report(node, "function", `${node.expression.text}["Function"]`);
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // (async () => {}).constructor("…") reaches AsyncFunction without naming it.
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "constructor") {
        report(callee.name, "function", ".constructor(");
      }
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        const name = moduleName(node.arguments[0]);
        if (name !== undefined && VM_MODULES.has(name)) report(node.arguments[0] as ts.Node, "vm", name);
      }
      const timer = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            GLOBAL_OBJECTS.has(callee.expression.text)
          ? callee.name.text
          : undefined;
      if (timer !== undefined && TIMERS.has(timer) && stringArgument(node.arguments[0])) {
        report(callee, "string-timer", timer);
      }
    }

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const name = moduleName(node.moduleSpecifier);
      if (name !== undefined && VM_MODULES.has(name)) report(node.moduleSpecifier, "vm", name);
    }
    if (ts.isExternalModuleReference(node)) {
      const name = moduleName(node.expression);
      if (name !== undefined && VM_MODULES.has(name)) report(node.expression, "vm", name);
    }

    ts.forEachChild(node, visit);
  };
  visit(file);
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
    process.stderr.write(`${f.path}:${f.line}:${f.column}  no-dynamic-code/${f.rule}  "${f.match}"  ${f.message}\n`);
  }
  if (findings.length > 0) {
    process.stderr.write(`\n${findings.length} no-dynamic-code problem(s). ADR-003: no eval, Function or vm.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
