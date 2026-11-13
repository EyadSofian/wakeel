import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { checkContrast, contrast, darkDrift, luminance, parseOklch, parseTokens, TOKENS_PATH } from "../contrast";

describe("colour maths", () => {
  test("white and black are 21:1", () => {
    expect(contrast("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 1);
  });

  test("luminance of white is 1 and of black 0", () => {
    expect(luminance("oklch(1 0 0)")).toBeCloseTo(1, 4);
    expect(luminance("oklch(0 0 0)")).toBeCloseTo(0, 6);
  });

  test("a mid grey matches its sRGB luminance", () => {
    // oklch(0.5998 0 0) is sRGB #808080, whose WCAG luminance is 0.2159.
    expect(luminance("oklch(0.5998 0 0)")).toBeCloseTo(0.2159, 3);
  });

  test("contrast is symmetric", () => {
    expect(contrast("oklch(0.45 0.006 265)", "oklch(1 0 0)")).toBe(contrast("oklch(1 0 0)", "oklch(0.45 0.006 265)"));
  });

  test.each(["#fff", "rgb(0 0 0)", "oklch(a b c)"])("rejects %s", (value) => {
    expect(() => parseOklch(value)).toThrow(/oklch/);
  });

  test("accepts an alpha channel", () => {
    expect(parseOklch("oklch(0 0 0 / 0.32)")).toEqual([0, 0, 0]);
  });
});

describe("tokens.css", () => {
  const tokens = parseTokens(readFileSync(TOKENS_PATH, "utf8"));

  test("every required pair passes in both themes (acceptance 0.7: pnpm ui:contrast)", () => {
    const results = checkContrast(tokens);
    expect(results).toHaveLength(24);
    expect(results.filter((r) => !r.pass)).toEqual([]);
  });

  test("the system-preference dark block equals the pinned dark block", () => {
    expect(darkDrift(tokens.dark, tokens.systemDark)).toEqual([]);
  });

  test("a token below its minimum fails", () => {
    const light = { ...tokens.light, "--text-secondary": "oklch(0.75 0.006 265)" };
    const failed = checkContrast({ light, dark: tokens.dark }).filter((r) => !r.pass);
    expect(failed.map((r) => `${r.theme} ${r.text} ${r.background}`)).toContain("light --text-secondary --bg-surface");
  });

  test("drift between the dark blocks is reported", () => {
    expect(darkDrift({ "--accent": "oklch(0.7 0.15 268)" }, { "--accent": "oklch(0.7 0.15 260)" })).toEqual([
      "--accent",
    ]);
  });
});
