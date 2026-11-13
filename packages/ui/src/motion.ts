/**
 * Motion tokens (design system §2.6). The only place animation values are written; components read
 * them through `motionTokens()` (and, from task 0.8, the `useMotionTokens()` hook), never numbers.
 *
 * Units follow Motion (`motion/react`): durations and stagger in seconds, springs by
 * `visualDuration` in seconds and `bounce`.
 */

export const duration = {
  /** 80 ms: colour and opacity on hover or press. */
  instant: 0.08,
  /** 120 ms: tooltips, menu open, focus ring. */
  fast: 0.12,
  /** 160 ms: popovers, tab indicator, card insert. */
  base: 0.16,
  /** 200 ms: panels, inspector content swap. */
  slow: 0.2,
  /** 240 ms: dialogs, node add and remove. */
  slower: 0.24,
} as const;

export interface SpringToken {
  readonly type: "spring";
  readonly visualDuration: number;
  readonly bounce: number;
}

export const spring = {
  /** Small things that follow the pointer: reorder, toggle, port snap. */
  snappy: { type: "spring", visualDuration: 0.12, bounce: 0 },
  /** Layout changes: node height, panel width, list reflow. */
  smooth: { type: "spring", visualDuration: 0.18, bounce: 0.06 },
  /** Entrances that travel: node add, dialog, palette. */
  gentle: { type: "spring", visualDuration: 0.24, bounce: 0.1 },
} as const satisfies Record<string, SpringToken>;

/** A cubic-bezier curve as Motion takes it. */
export type CubicBezier = [number, number, number, number];

export const ease: { readonly out: CubicBezier } = {
  /** Opacity and colour (non-spring). */
  out: [0.2, 0, 0, 1],
};

export const stagger = {
  /** Trace steps, emulator message groups: 24 ms per item, at most 8 items. */
  list: { each: 0.024, maxItems: 8 },
} as const;

/** Scale a thing starts from when it grows in (§5.1 node add, §5.15 command palette). */
export const scale = {
  /** Node add: 0.96 → 1. */
  node: 0.96,
  /** Command palette: 0.98 → 1. */
  palette: 0.98,
} as const;

/** Enter travels 4–8 px from where the thing came from; exit is a fade at 0.75× the enter time. */
export const travel = { min: 4, max: 8 } as const;
export const EXIT_DURATION_FACTOR = 0.75;

/** The bounce ceiling: nothing overshoots visibly. */
export const MAX_BOUNCE = 0.1;

export interface Transition {
  readonly duration?: number;
  readonly ease?: CubicBezier;
  readonly type?: "spring" | "tween";
  readonly visualDuration?: number;
  readonly bounce?: number;
}

export interface MotionTokens {
  readonly reduced: boolean;
  readonly duration: typeof duration;
  /** Springs, or an 80 ms opacity tween in place of each when motion is reduced. */
  readonly spring: Record<keyof typeof spring, Transition>;
  readonly ease: typeof ease;
  readonly stagger: { readonly list: { readonly each: number; readonly maxItems: number } };
  /** Pixels an entrance travels; 0 when motion is reduced. */
  readonly travel: number;
  /** Pan inertia after a flick (§5.1); off when motion is reduced. */
  readonly panInertia: boolean;
}

const reducedTransition: Transition = { type: "tween", duration: duration.instant, ease: ease.out };

/**
 * The token set for the user's motion preference. With `prefers-reduced-motion: reduce`, every spring
 * and travel becomes an 80 ms opacity change, list stagger stops and pan inertia is off (§2.6).
 */
export function motionTokens(reduced: boolean): MotionTokens {
  if (!reduced) {
    return { reduced, duration, spring, ease, stagger, travel: travel.max, panInertia: true };
  }
  return {
    reduced,
    duration,
    spring: { snappy: reducedTransition, smooth: reducedTransition, gentle: reducedTransition },
    ease,
    stagger: { list: { each: 0, maxItems: stagger.list.maxItems } },
    travel: 0,
    panInertia: false,
  };
}

/** Exit transition for an entrance of `enter` seconds: fade only, 0.75× as long. */
export const exitDuration = (enter: number) => enter * EXIT_DURATION_FACTOR;

/**
 * Per-value transition for an entrance (§2.6): travel (`y`/`x`) on `spring`, opacity on `ease.out`
 * over the matching duration, since opacity and colour never use springs. With reduced motion both
 * are the 80 ms opacity tween. Pass as Motion's `transition` prop or inside `animate`.
 */
export function enterTransition(
  tokens: MotionTokens,
  kind: "gentle" | "smooth" | "snappy" = "gentle",
): { y: Transition; x: Transition; opacity: Transition } {
  const travel = tokens.spring[kind];
  const fade: Transition = tokens.reduced
    ? { type: "tween", duration: duration.instant, ease: ease.out }
    : { type: "tween", duration: FADE_DURATION[kind], ease: ease.out };
  return { y: travel, x: travel, opacity: fade };
}

const FADE_DURATION = { gentle: duration.slower, smooth: duration.slow, snappy: duration.fast } as const;

/** Exit (§2.6): fade only, 0.75× the entrance time; 80 ms when motion is reduced. */
export function exitTransition(tokens: MotionTokens, kind: "gentle" | "smooth" | "snappy" = "gentle"): Transition {
  return {
    type: "tween",
    duration: tokens.reduced ? duration.instant : exitDuration(FADE_DURATION[kind]),
    ease: ease.out,
  };
}
