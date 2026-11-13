import { describe, expect, test } from "vitest";
import { type ThemeTokens, TOKEN_VARIABLES, themeData } from "./monaco-theme";

const tokens: ThemeTokens = {
  surface: "#ffffff",
  subtle: "#f6f7f9",
  muted: "#eef0f3",
  hairline: "#e5e7eb",
  strong: "#d4d7dd",
  primary: "#1d2030",
  secondary: "#5b5f70",
  tertiary: "#7d8191",
  accent: "#4f46e5",
  accentSubtle: "#eef0ff",
  error: "#c53030",
  warning: "#8a5a00",
};

describe("code editor theme (design system §4: built from tokens)", () => {
  test("every theme token reads a token variable that exists in tokens.css", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../../../../packages/ui/src/tokens.css", import.meta.url), "utf8");
    for (const variable of Object.values(TOKEN_VARIABLES)) expect(css).toContain(`${variable}:`);
  });

  test("every colour in the theme is one of the tokens", () => {
    const allowed = new Set(Object.values(tokens));
    const theme = themeData(tokens, false);
    for (const value of Object.values(theme.colors)) expect(allowed).toContain(value);
    for (const rule of theme.rules) {
      if (rule.foreground) expect(allowed).toContain(`#${rule.foreground}`);
    }
  });

  test("syntax is told apart by weight and the text greys, never by the accent or a status colour", () => {
    const theme = themeData(tokens, false);
    const greys = new Set([tokens.primary, tokens.secondary, tokens.tertiary].map((c) => c.slice(1)));
    for (const rule of theme.rules) expect(greys).toContain(rule.foreground);
    expect(theme.rules.find((r) => r.token === "keyword")?.fontStyle).toBe("bold");
    expect(theme.colors["editorError.foreground"]).toBe(tokens.error);
    expect(theme.colors["editor.selectionBackground"]).toBe(tokens.accentSubtle);
  });

  test("dark builds on Monaco's dark base, light on its light base", () => {
    expect(themeData(tokens, true).base).toBe("vs-dark");
    expect(themeData(tokens, false).base).toBe("vs");
    expect(themeData(tokens, true).inherit).toBe(false);
  });
});
