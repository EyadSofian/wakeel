/**
 * `pnpm ui:contrast` (design system §2.1): checks every text token against every background token
 * in both themes and fails below the required WCAG contrast ratio.
 *
 *   --text-primary, --text-secondary on any --bg-*   ≥ 4.5:1
 *   --text-tertiary on any --bg-*                    ≥ 3:1
 *
 * Also fails if the two dark blocks in tokens.css (system preference and pinned) differ.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TOKENS_PATH = fileURLToPath(new URL("../packages/ui/src/tokens.css", import.meta.url));

export type Theme = "light" | "dark";
export type TokenMap = Record<string, string>;

/** Requirements from §2.1. */
export const REQUIREMENTS: { text: string; min: number }[] = [
  { text: "--text-primary", min: 4.5 },
  { text: "--text-secondary", min: 4.5 },
  { text: "--text-tertiary", min: 3 },
];
export const BACKGROUNDS = ["--bg-canvas", "--bg-surface", "--bg-subtle", "--bg-muted"];

/** Reads the custom properties of the light block, the pinned dark block and the system dark block. */
export function parseTokens(css: string): { light: TokenMap; dark: TokenMap; systemDark: TokenMap } {
  const block = (selector: RegExp): TokenMap => {
    const match = selector.exec(css);
    if (!match) throw new Error(`tokens.css: block ${selector} not found`);
    const body = css.slice(match.index + match[0].length, css.indexOf("}", match.index));
    const out: TokenMap = {};
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      if (m[1] && m[2]) out[m[1]] = m[2].trim();
    }
    return out;
  };
  return {
    light: block(/^:root\s*\{/m),
    dark: block(/^:root\[data-theme="dark"\]\s*\{/m),
    systemDark: block(/:root:not\(\[data-theme="light"\]\)\s*\{/),
  };
}

/** OKLCH (L 0–1, C, H degrees) to linear sRGB, clipped to the gamut (Björn Ottosson's matrices). */
export function oklchToLinearSrgb(l: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

export function parseOklch(value: string): [number, number, number] {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+\s*)?\)$/.exec(value.trim());
  if (!m) throw new Error(`Not an oklch() colour: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG relative luminance from linear sRGB. */
export function luminance(value: string): number {
  const [r, g, b] = oklchToLinearSrgb(...parseOklch(value));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface PairResult {
  theme: Theme;
  text: string;
  background: string;
  ratio: number;
  min: number;
  pass: boolean;
}

export function checkContrast(tokens: { light: TokenMap; dark: TokenMap }): PairResult[] {
  const results: PairResult[] = [];
  for (const theme of ["light", "dark"] as const) {
    const t = tokens[theme];
    for (const { text, min } of REQUIREMENTS) {
      for (const background of BACKGROUNDS) {
        const fg = t[text];
        const bg = t[background];
        if (!fg || !bg) throw new Error(`tokens.css (${theme}): ${!fg ? text : background} is missing`);
        const ratio = contrast(fg, bg);
        results.push({ theme, text, background, ratio, min, pass: ratio >= min });
      }
    }
  }
  return results;
}

/** Keys whose values differ between the two dark blocks. */
export function darkDrift(dark: TokenMap, systemDark: TokenMap): string[] {
  const keys = new Set([...Object.keys(dark), ...Object.keys(systemDark)]);
  return [...keys].filter((k) => dark[k] !== systemDark[k]).sort();
}

function main(): void {
  const tokens = parseTokens(readFileSync(TOKENS_PATH, "utf8"));
  const results = checkContrast(tokens);
  for (const r of results) {
    const mark = r.pass ? "pass" : "FAIL";
    process.stdout.write(
      `${mark}  ${r.theme.padEnd(5)}  ${r.text.padEnd(16)} on ${r.background.padEnd(12)}  ${r.ratio.toFixed(2)}:1  (min ${r.min})\n`,
    );
  }
  const failed = results.filter((r) => !r.pass);
  const drift = darkDrift(tokens.dark, tokens.systemDark);
  if (drift.length > 0) {
    process.stdout.write(`FAIL  the two dark blocks in tokens.css differ for: ${drift.join(", ")}\n`);
  }
  if (failed.length > 0 || drift.length > 0) {
    process.stdout.write(
      `\n${failed.length} pair(s) below the minimum. Change the token in tokens.css (with an ADR, design system §2.1).\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nAll ${results.length} pairs meet design system §2.1.\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
