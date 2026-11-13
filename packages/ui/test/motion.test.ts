import { describe, expect, test } from "vitest";
import { duration, ease, exitDuration, MAX_BOUNCE, motionTokens, spring, stagger } from "../src/motion";

describe("motion tokens match design system §2.6", () => {
  test("durations in seconds", () => {
    expect(duration).toEqual({ instant: 0.08, fast: 0.12, base: 0.16, slow: 0.2, slower: 0.24 });
  });

  test("springs", () => {
    expect(spring.snappy).toEqual({ type: "spring", visualDuration: 0.12, bounce: 0 });
    expect(spring.smooth).toEqual({ type: "spring", visualDuration: 0.18, bounce: 0.06 });
    expect(spring.gentle).toEqual({ type: "spring", visualDuration: 0.24, bounce: 0.1 });
  });

  test("no spring overshoots visibly", () => {
    for (const s of Object.values(spring)) expect(s.bounce).toBeLessThanOrEqual(MAX_BOUNCE);
  });

  test("ease and stagger", () => {
    expect(ease.out).toEqual([0.2, 0, 0, 1]);
    expect(stagger.list).toEqual({ each: 0.024, maxItems: 8 });
  });

  test("exit is 0.75× the enter duration", () => {
    expect(exitDuration(duration.slower)).toBeCloseTo(0.18, 10);
  });
});

describe("reduced motion", () => {
  const reduced = motionTokens(true);

  test("every spring becomes an 80 ms opacity tween", () => {
    for (const t of Object.values(reduced.spring)) {
      expect(t).toEqual({ type: "tween", duration: 0.08, ease: [0.2, 0, 0, 1] });
    }
  });

  test("no travel, no stagger, no pan inertia", () => {
    expect(reduced.travel).toBe(0);
    expect(reduced.stagger.list.each).toBe(0);
    expect(reduced.panInertia).toBe(false);
  });

  test("full motion keeps springs and travel", () => {
    const full = motionTokens(false);
    expect(full.spring.gentle).toBe(spring.gentle);
    expect(full.travel).toBe(8);
    expect(full.panInertia).toBe(true);
  });
});

describe("CSS motion tokens", () => {
  test("tokens.css durations and easing equal motion.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
    const root = css.slice(0, css.indexOf("}"));
    const ms = (name: string) => Number(new RegExp(`--duration-${name}:\\s*(\\d+)ms`).exec(root)?.[1]) / 1000;
    for (const [name, seconds] of Object.entries(duration)) expect(ms(name)).toBe(seconds);
    expect(root).toContain(`--ease-out: cubic-bezier(${ease.out.join(", ")});`);
  });
});

describe("enter and exit transitions", () => {
  test("travel springs, opacity eases (opacity never uses a spring)", async () => {
    const { enterTransition, exitTransition } = await import("../src/motion");
    const full = enterTransition(motionTokens(false));
    expect(full.y).toEqual(spring.gentle);
    expect(full.opacity).toEqual({ type: "tween", duration: 0.24, ease: [0.2, 0, 0, 1] });
    expect(exitTransition(motionTokens(false))).toEqual({ type: "tween", duration: 0.18, ease: [0.2, 0, 0, 1] });
  });

  test("reduced motion: everything is an 80 ms tween", async () => {
    const { enterTransition, exitTransition } = await import("../src/motion");
    const reduced = enterTransition(motionTokens(true));
    for (const t of [reduced.y, reduced.x, reduced.opacity, exitTransition(motionTokens(true))]) {
      expect(t).toEqual({ type: "tween", duration: 0.08, ease: [0.2, 0, 0, 1] });
    }
  });
});
