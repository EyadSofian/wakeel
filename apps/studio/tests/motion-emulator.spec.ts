import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { EmulatorScenario } from "./emulator-fixtures";
import { mockApi, WS } from "./mock-api";

/**
 * `pnpm studio:motion --screen emulator` (task 4.6, design system §5.3 motion table): the user's
 * bubble entering, the typing indicator, and choice buttons fading in after the bot's text, at
 * normal and reduced motion, on the mock API.
 *
 * These entrances last 80–300 ms, shorter than a round trip from the test, so the page's animation
 * playback is slowed through the DevTools protocol before each one; the measured timing comes from
 * the effects themselves and is unaffected. Frames are then sought to 0, 25, 50, 75 and 100%.
 * Output: apps/studio/.motion/emulator/<interaction>-<mode>-<pct>.png and -timing.json.
 */
const DIR = fileURLToPath(new URL("../.motion/emulator", import.meta.url));
const ROUTE = `/w/${WS}/b/bot_01m7a256m0a13warwhczsjhx9b`;
const MODES = [
  { id: "normal", reducedMotion: "no-preference" },
  { id: "reduced", reducedMotion: "reduce" },
] as const;
const PERCENTS = [0, 25, 50, 75, 100];

test.skip(
  !!process.env["REVIEW_SCREEN"] && process.env["REVIEW_SCREEN"] !== "emulator",
  "Only for --screen emulator or a full run",
);
test.use({ viewport: { width: 1440, height: 900 } });

async function open(page: Page, reducedMotion: "reduce" | "no-preference", scenario: EmulatorScenario) {
  await page.emulateMedia({ reducedMotion });
  await mockApi(page, "default", "typical", scenario);
  await page.goto(ROUTE);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  return page.getByRole("complementary", { name: "Emulator" });
}

/** Slows Web Animations (opacity fades) so a frame can be sought before they finish. */
async function slowAnimations(page: Page, rate: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: rate });
}

/** Pauses every finite animation under `target`, records its timing, and shoots seek frames. */
async function frames(target: Locator, prefix: string) {
  const handle = await target.elementHandle();
  if (!handle) throw new Error("no target");
  const timing = await handle.evaluate((el) => {
    const animations = el.getAnimations({ subtree: true });
    for (const a of animations) a.pause();
    return animations.map((a) => {
      const effect = a.effect as KeyframeEffect;
      const t = effect.getTiming();
      const props = [
        ...new Set(
          effect
            .getKeyframes()
            .flatMap((k) => Object.keys(k))
            .filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
        ),
      ];
      return {
        props,
        delayMs: Math.round(Number(t.delay ?? 0)),
        durationMs: Math.round(Number(t.duration)),
        iterations: t.iterations === Number.POSITIVE_INFINITY ? "infinite" : t.iterations,
      };
    });
  });
  writeFileSync(`${prefix}-timing.json`, `${JSON.stringify({ animations: timing }, null, 2)}\n`);
  const finite = timing.filter((t) => t.iterations !== "infinite");
  const total = Math.max(0, ...finite.map((t) => t.delayMs + t.durationMs));
  for (const pct of PERCENTS) {
    const at = (total * pct) / 100;
    await handle.evaluate((el, at) => {
      for (const a of el.getAnimations({ subtree: true })) {
        const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
        a.currentTime = Number.isFinite(end) ? Math.min(at, end) : at;
      }
    }, at);
    await target.screenshot({ path: `${prefix}-${String(pct).padStart(3, "0")}.png` });
  }
  return timing;
}

for (const mode of MODES) {
  test(`emulator send ${mode.id}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    const panel = await open(page, mode.reducedMotion, "running");
    const box = panel.getByRole("textbox", { name: "Message the bot" });
    await box.fill("عايز أعرف حالة طلبي");
    // Motion runs the bubble's rise (an independent `y` transform) on the main thread, not as a Web
    // Animation, so it is sampled every frame: offset from its final place and opacity, for 400 ms.
    await page.evaluate(() => {
      const w = window as unknown as { __samples: { t: number; dy: number; opacity: number }[] };
      w.__samples = [];
      // Before the first message the panel shows its empty state; the log appears with the bubble.
      const root = document.querySelector('[aria-label="Emulator"]');
      if (!root) return;
      const t0 = performance.now();
      const observer = new MutationObserver(() => {
        const item = root.querySelector('[role="log"] > div') as HTMLElement | null;
        if (!item) return;
        observer.disconnect();
        const sample = () => {
          const t = performance.now() - t0;
          const m = new DOMMatrixReadOnly(getComputedStyle(item).transform);
          w.__samples.push({
            t: Math.round(t),
            dy: Math.round(m.m42 * 10) / 10,
            opacity: Number(getComputedStyle(item).opacity),
          });
          if (t < 400) requestAnimationFrame(sample);
        };
        sample();
      });
      observer.observe(root, { childList: true, subtree: true });
    });
    await box.press("Enter");
    // The composer clears at once (§5.3), before any animation has moved.
    await expect(box).toHaveValue("");
    await page.waitForTimeout(500);
    const samples = await page.evaluate(
      () => (window as unknown as { __samples: { t: number; dy: number; opacity: number }[] }).__samples,
    );
    writeFileSync(`${DIR}/send-${mode.id}-samples.json`, `${JSON.stringify(samples, null, 2)}\n`);
    expect(samples.length).toBeGreaterThan(3);
    const first = samples[0];
    const last = samples.at(-1);
    if (mode.id === "normal") {
      // Rises 8 px and fades in (spring.snappy); ends in place, fully opaque.
      expect(first?.dy).toBeGreaterThan(0);
      expect(first?.dy).toBeLessThanOrEqual(8);
    } else {
      // Reduced motion: no travel at all, only the 80 ms fade.
      expect(samples.every((x) => x.dy === 0)).toBe(true);
    }
    expect(first?.opacity).toBeLessThan(1);
    expect(last).toMatchObject({ dy: 0, opacity: 1 });
    await panel.getByRole("log").screenshot({ path: `${DIR}/send-${mode.id}-100.png` });
  });

  test(`emulator choices ${mode.id}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    const panel = await open(page, mode.reducedMotion, "conversation");
    const box = panel.getByRole("textbox", { name: "Message the bot" });
    await box.fill("عايز أعرف حالة طلبي");
    await slowAnimations(page, 0.02);
    await box.press("Enter");
    const choices = panel.getByRole("group", { name: "Choices" });
    await expect(choices).toBeAttached();
    const timing = await frames(choices, `${DIR}/choices-${mode.id}`);
    expect(timing.some((t) => t.props.includes("opacity"))).toBe(true);
  });
}
