/**
 * Every screen the review loop shoots (design system §8.1). Add a screen here when it exists; each
 * state is set up by `prepare` in shots.spec.ts. Every content surface includes the RTL fixtures.
 */
export type ScreenState =
  | "default"
  | "focus"
  | "empty"
  | "loading"
  | "error"
  | "rtl"
  // Canvas (task 2.4, design system §8.1): a 300-node flow, a multi-selection, validation issues.
  | "dense-300"
  | "selection"
  | "issues"
  // Task 2.5: the add-node and card menus, the shortcut sheet, the keyboard cursor in a node.
  | "node-menu"
  | "card-menu"
  | "shortcuts"
  | "cursor"
  // Task 2.6: the inspector's card forms.
  | "card-say"
  | "card-ask"
  | "card-condition"
  | "card-invalid"
  | "card-rtl"
  // Task 2.7: the Variables screen's dialogs and the VariablePicker in the inspector.
  | "usages"
  | "edit"
  | "delete-blocked"
  | "picker"
  // Task 2.8: the command palette, the Issues panel and the Workflows panel with its menu and dialog.
  | "palette"
  | "palette-search"
  | "issues-panel"
  | "issues-panel-rtl"
  | "workflows"
  | "workflow-menu"
  | "workflow-delete"
  | "workflows-rtl"
  | "save-offline";

export interface Screen {
  id: string;
  route: string;
  states: ScreenState[];
  sizes: [width: number, height: number][];
  /** Screens that load data get it from the mock API layer (tests/mock-api.ts). */
  mock?: boolean;
  /** Scripted interactions for `studio:motion`. */
  interactions: { id: string; trigger: string; target: string; durationMs: number }[];
}

export const SCREENS: Screen[] = [
  {
    id: "gallery",
    route: "/__gallery",
    states: ["default", "focus"],
    sizes: [
      [1440, 900],
      [1280, 720],
    ],
    interactions: [
      // spring.gentle: visualDuration 240 ms.
      {
        id: "popover-enter",
        trigger: '[data-testid="motion-toggle"]',
        target: '[data-section="motion"]',
        durationMs: 240,
      },
    ],
  },
  // Router-level states (design system §3.3): an unknown address and an unexpected error.
  {
    id: "not-found",
    route: "/__does-not-exist",
    states: ["default", "focus"],
    sizes: [
      [1440, 900],
      [1280, 720],
    ],
    interactions: [],
  },
  {
    id: "error",
    route: "/__gallery/error",
    states: ["default", "focus"],
    sizes: [
      [1440, 900],
      [1280, 720],
    ],
    interactions: [],
  },
];

const DESKTOP: [number, number][] = [
  [1440, 900],
  [1280, 720],
];

// Phase 1 screens (task 1.7). Each has its empty, loading, error and RTL states (CLAUDE.md §9).
const WS = "ws_01m7a256m0a13warwhczsjhx9g";
SCREENS.push(
  {
    id: "sign-in",
    route: "/sign-in",
    states: ["default", "focus", "error"],
    sizes: DESKTOP,
    mock: true,
    interactions: [],
  },
  {
    id: "home",
    route: `/w/${WS}`,
    states: ["default", "focus", "empty", "loading", "error", "rtl"],
    sizes: DESKTOP,
    mock: true,
    interactions: [],
  },
  {
    id: "settings-general",
    route: `/w/${WS}/settings/general`,
    states: ["default", "focus", "loading", "error", "rtl"],
    sizes: DESKTOP,
    mock: true,
    interactions: [],
  },
  {
    id: "settings-members",
    route: `/w/${WS}/settings/members`,
    states: ["default", "focus", "empty", "loading", "error", "rtl"],
    sizes: DESKTOP,
    mock: true,
    interactions: [],
  },
  {
    id: "settings-api-keys",
    route: `/w/${WS}/settings/api-keys`,
    states: ["default", "focus", "empty", "loading", "error", "rtl"],
    sizes: DESKTOP,
    mock: true,
    interactions: [],
  },
);

// Phase 2: the bot canvas (task 2.4). "default" is the typical bot; "empty" is a lone Start node.
SCREENS.push({
  id: "canvas",
  route: `/w/${WS}/b/bot_01m7a256m0a13warwhczsjhx9b`,
  states: [
    "default",
    "empty",
    "dense-300",
    "selection",
    "issues",
    "loading",
    "error",
    "rtl",
    "node-menu",
    "card-menu",
    "shortcuts",
    "cursor",
    "card-say",
    "card-ask",
    "card-condition",
    "card-invalid",
    "card-rtl",
    "picker",
    "palette",
    "palette-search",
    "issues-panel",
    "issues-panel-rtl",
    "workflows",
    "workflow-menu",
    "workflow-delete",
    "workflows-rtl",
    "save-offline",
  ],
  sizes: DESKTOP,
  mock: true,
  interactions: [],
});

// Task 2.7: the Variables screen (design system §5.7).
SCREENS.push({
  id: "variables",
  route: `/w/${WS}/b/bot_01m7a256m0a13warwhczsjhx9b/variables`,
  states: ["default", "focus", "empty", "loading", "error", "rtl", "usages", "edit", "delete-blocked"],
  sizes: DESKTOP,
  mock: true,
  interactions: [],
});

export const THEMES = ["light", "dark"] as const;

/** Screens selected by REVIEW_SCREEN (set by `--screen <id>`), or all. */
export function selectedScreens(env: string | undefined = process.env["REVIEW_SCREEN"]): Screen[] {
  if (!env) return SCREENS;
  const found = SCREENS.filter((s) => s.id === env);
  if (found.length === 0) throw new Error(`Unknown screen "${env}". Known: ${SCREENS.map((s) => s.id).join(", ")}`);
  return found;
}
