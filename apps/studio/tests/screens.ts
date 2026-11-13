/**
 * Every screen the review loop shoots (design system §8.1). Add a screen here when it exists; each
 * state is set up by `prepare` in shots.spec.ts. Every content surface includes the RTL fixtures.
 */
export type ScreenState = "default" | "focus";

export interface Screen {
  id: string;
  route: string;
  states: ScreenState[];
  sizes: [width: number, height: number][];
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

export const THEMES = ["light", "dark"] as const;

/** Screens selected by REVIEW_SCREEN (set by `--screen <id>`), or all. */
export function selectedScreens(env: string | undefined = process.env["REVIEW_SCREEN"]): Screen[] {
  if (!env) return SCREENS;
  const found = SCREENS.filter((s) => s.id === env);
  if (found.length === 0) throw new Error(`Unknown screen "${env}". Known: ${SCREENS.map((s) => s.id).join(", ")}`);
  return found;
}
