import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/** Compiles theme.css with the real Tailwind CLI against sample markup and inspects the CSS. */
const theme = fileURLToPath(new URL("../src/theme.css", import.meta.url));
const tailwind = fileURLToPath(new URL("../node_modules/.bin/tailwindcss", import.meta.url));

const TOKEN_CLASSES =
  "bg-canvas bg-surface text-primary text-secondary border-hairline p-4 gap-5 h-control w-inspector size-icon rounded-md rounded-full shadow-pop text-body text-title font-sans font-mono font-medium";
const DEFAULT_CLASSES = "bg-red-500 bg-white text-black p-13 w-96 rounded-2xl shadow-lg text-sm font-serif";

let dir: string;
let css: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wakeel-theme-"));
  writeFileSync(join(dir, "app.css"), `@import "tailwindcss";\n@import "${theme}";\n@source "./sample.html";\n`);
  writeFileSync(join(dir, "sample.html"), `<div class="${TOKEN_CLASSES}"></div><div class="${DEFAULT_CLASSES}"></div>`);
  const result = spawnSync(tailwind, ["-i", join(dir, "app.css"), "-o", join(dir, "out.css")], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tailwindcss failed: ${result.stderr}`);
  css = readFileSync(join(dir, "out.css"), "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rule = (cls: string) => {
  const m = new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[1]?.replace(/\s+/g, " ").trim();
};

describe("token utilities", () => {
  test.each([
    ["bg-canvas", "background-color: var(--bg-canvas);"],
    ["text-secondary", "color: var(--text-secondary);"],
    ["p-4", "padding: var(--space-4);"],
    ["gap-5", "gap: var(--space-5);"],
    ["h-control", "height: var(--size-control);"],
    ["w-inspector", "width: var(--size-inspector);"],
    ["rounded-md", "border-radius: var(--radius-md);"],
    ["font-mono", "font-family: var(--font-mono);"],
  ])("%s → %s", (cls, declaration) => {
    expect(rule(cls)).toContain(declaration);
  });

  test("text sizes carry their line height", () => {
    expect(rule("text-body")).toMatch(/font-size: 13px; line-height: var\(--tw-leading, 20px\);/);
  });

  test("shadow-pop uses the token, so the dark theme applies", () => {
    expect(rule("shadow-pop")).toContain("--tw-shadow: var(--shadow-pop);");
  });
});

describe("only tokens exist", () => {
  test.each(DEFAULT_CLASSES.split(" "))("%s is not generated", (cls) => {
    expect(rule(cls)).toBeUndefined();
  });

  test("Tailwind defines no variables that shadow or loop on the tokens", () => {
    expect(css).not.toMatch(/--(radius-md|shadow-pop|font-sans|font-mono)\s*:\s*var\(--\1\)/);
    expect(css).not.toMatch(/--color-red-500/);
  });

  test("the page base uses Plex at 13/20", () => {
    const html = /html, :host \{([^}]*)\}/g;
    const blocks = [...css.matchAll(html)].map((m) => m[1] ?? "");
    expect(blocks.some((b) => b.includes("font-family: var(--font-sans)") && b.includes("font-size: 13px"))).toBe(true);
  });

  test("both dark selectors ship with the tokens", () => {
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain(':root:not([data-theme="light"])');
  });
});
