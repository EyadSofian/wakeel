import type { editor } from "monaco-editor";

/**
 * The code editor's theme, built from the design tokens (design system §4 CodeEditor: "theme built
 * from tokens"). §2.1 keeps the accent for selection and focus and the category colours for
 * nodes, so syntax is told apart by weight and the three text greys, not by hue: keywords are
 * semibold, strings and numbers secondary, comments tertiary. Error and warning squiggles use the
 * status colours because they are statuses.
 */

/** The tokens the theme uses, as `#rrggbb`. */
export interface ThemeTokens {
  surface: string;
  subtle: string;
  muted: string;
  hairline: string;
  strong: string;
  primary: string;
  secondary: string;
  tertiary: string;
  accent: string;
  accentSubtle: string;
  error: string;
  warning: string;
}

/** CSS custom property behind each theme token. */
export const TOKEN_VARIABLES: Record<keyof ThemeTokens, string> = {
  surface: "--bg-surface",
  subtle: "--bg-subtle",
  muted: "--bg-muted",
  hairline: "--border-hairline",
  strong: "--border-strong",
  primary: "--text-primary",
  secondary: "--text-secondary",
  tertiary: "--text-tertiary",
  accent: "--accent",
  accentSubtle: "--accent-subtle",
  error: "--error",
  warning: "--warning",
};

export const THEME_NAME = "studio";

/** Monaco theme data for these token values. Pure. */
export function themeData(t: ThemeTokens, dark: boolean): editor.IStandaloneThemeData {
  const fg = (hex: string) => hex.slice(1);
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: false,
    rules: [
      { token: "", foreground: fg(t.primary), background: fg(t.surface) },
      { token: "keyword", foreground: fg(t.primary), fontStyle: "bold" },
      { token: "type", foreground: fg(t.primary) },
      { token: "identifier", foreground: fg(t.primary) },
      { token: "string", foreground: fg(t.secondary) },
      { token: "regexp", foreground: fg(t.secondary) },
      { token: "number", foreground: fg(t.secondary) },
      { token: "delimiter", foreground: fg(t.secondary) },
      { token: "comment", foreground: fg(t.tertiary) },
    ],
    colors: {
      focusBorder: t.accent,
      foreground: t.primary,
      "editor.background": t.surface,
      "editor.foreground": t.primary,
      "editorGutter.background": t.surface,
      "editorLineNumber.foreground": t.tertiary,
      "editorLineNumber.activeForeground": t.secondary,
      "editor.lineHighlightBackground": t.subtle,
      "editor.lineHighlightBorder": t.subtle,
      "editorCursor.foreground": t.primary,
      "editor.selectionBackground": t.accentSubtle,
      "editor.inactiveSelectionBackground": t.muted,
      "editor.selectionHighlightBackground": t.muted,
      "editor.wordHighlightBackground": t.muted,
      // Bracket pair colours stay off; if Monaco draws pair colours anyway, they are all one grey.
      ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`editorBracketHighlight.foreground${n}`, t.secondary])),
      "editorBracketHighlight.unexpectedBracket.foreground": t.error,
      "editorBracketMatch.background": t.muted,
      "editorBracketMatch.border": t.strong,
      "editorIndentGuide.background1": t.hairline,
      "editorIndentGuide.activeBackground1": t.strong,
      "editorWhitespace.foreground": t.hairline,
      "editorError.foreground": t.error,
      "editorWarning.foreground": t.warning,
      "editorOverviewRuler.border": t.hairline,
      "editorWidget.background": t.surface,
      "editorWidget.foreground": t.primary,
      "editorWidget.border": t.hairline,
      "editorHoverWidget.background": t.surface,
      "editorHoverWidget.border": t.hairline,
      "editorSuggestWidget.background": t.surface,
      "editorSuggestWidget.border": t.hairline,
      "editorSuggestWidget.foreground": t.primary,
      "editorSuggestWidget.highlightForeground": t.primary,
      "editorSuggestWidget.focusHighlightForeground": t.primary,
      "editorSuggestWidget.selectedBackground": t.accentSubtle,
      "editorSuggestWidget.selectedForeground": t.primary,
      "editorSuggestWidgetStatus.foreground": t.tertiary,
      "list.hoverBackground": t.subtle,
      "list.highlightForeground": t.primary,
      "scrollbarSlider.background": t.muted,
      "scrollbarSlider.hoverBackground": t.strong,
      "scrollbarSlider.activeBackground": t.strong,
      "scrollbar.shadow": t.surface,
    },
  };
}

/**
 * Reads the current token values from the page. Monaco wants `#rrggbb`, and the tokens are OKLCH,
 * so each value is resolved by the browser (a probe element) and read back from one canvas pixel.
 */
export function readThemeTokens(root: HTMLElement = document.documentElement): ThemeTokens {
  const probe = document.createElement("span");
  probe.hidden = true;
  root.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    probe.remove();
    throw new Error("The browser gave no 2D canvas to read the colour tokens with.");
  }
  const toHex = (variable: string): string => {
    probe.style.color = `var(${variable})`;
    const resolved = getComputedStyle(probe).color;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = resolved;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  };
  try {
    return Object.fromEntries(
      Object.entries(TOKEN_VARIABLES).map(([key, variable]) => [key, toHex(variable)]),
    ) as unknown as ThemeTokens;
  } finally {
    probe.remove();
  }
}

/** Whether the page is in its dark theme right now: pinned by `data-theme`, or the system's. */
export function isDark(root: HTMLElement = document.documentElement): boolean {
  const pinned = root.dataset["theme"];
  if (pinned === "dark") return true;
  if (pinned === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
