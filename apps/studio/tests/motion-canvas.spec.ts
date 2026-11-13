import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mockApi, WS } from "./mock-api";

/**
 * `pnpm studio:motion --screen canvas` (task 2.5, design system §5.1 motion table): node add, card
 * reorder, connect and reconnect, at normal and reduced motion, on the mock API's typical bot.
 *
 * Animations that Motion runs (node entrance, card reorder settle) are paused and sought to 0, 25,
 * 50, 75 and 100% of their measured length, as in motion.spec.ts. Pointer-driven moments (a
 * transition following the pointer, the target highlight) have no animation to seek: they are
 * captured at fixed points of the drag instead. Every interaction is also recorded in real time.
 * Output: apps/studio/.motion/canvas/<interaction>-<mode>-<frame>.png, -timing.json, .webm
 */
const DIR = fileURLToPath(new URL("../.motion/canvas", import.meta.url));
const ROUTE = `/w/${WS}/b/bot_01m7a256m0a13warwhczsjhx9b`;
const MODES = [
  { id: "normal", reducedMotion: "no-preference" },
  { id: "reduced", reducedMotion: "reduce" },
] as const;
const PERCENTS = [0, 25, 50, 75, 100];

test.skip(
  !!process.env["REVIEW_SCREEN"] && process.env["REVIEW_SCREEN"] !== "canvas",
  "Only for --screen canvas or a full run",
);
test.use({ viewport: { width: 1440, height: 900 } });

async function open(
  page: Page,
  reducedMotion: "reduce" | "no-preference",
  fixture: "typical" | "issues" | "code" = "typical",
) {
  await page.emulateMedia({ reducedMotion });
  await mockApi(page, "default", fixture);
  await page.goto(ROUTE);
  await expect(page.locator('[data-validated="true"]')).toBeVisible();
  // Off-screen nodes are not rendered until the initial fit-view has run; wait for all six.
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await page.evaluate(() => document.fonts.ready);
}

const node = (page: Page, name: string) => page.locator(".react-flow__node").filter({ hasText: name });

/** Pauses every animation under `target`, records their timing, and shoots seek frames. */
async function frames(target: Locator, prefix: string) {
  const handle = await target.elementHandle();
  if (!handle) throw new Error("no target");
  const timing = await handle.evaluate((el) => {
    const animations = el.getAnimations({ subtree: true });
    for (const a of animations) a.pause();
    return animations.map((a) => {
      const effect = a.effect as KeyframeEffect;
      const props = [
        ...new Set(
          effect
            .getKeyframes()
            .flatMap((k) => Object.keys(k))
            .filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)),
        ),
      ];
      return { props, durationMs: Math.round(Number(effect.getComputedTiming().endTime)) };
    });
  });
  const total = Math.max(0, ...timing.map((t) => t.durationMs));
  writeFileSync(`${prefix}-timing.json`, `${JSON.stringify({ totalMs: total, animations: timing }, null, 2)}\n`);
  for (const pct of PERCENTS) {
    await handle.evaluate(
      (el, at) => {
        for (const a of el.getAnimations({ subtree: true })) {
          a.currentTime = Math.min(at, Number(a.effect?.getComputedTiming().endTime ?? 0));
        }
      },
      (total * pct) / 100,
    );
    await target.screenshot({ path: `${prefix}-${String(pct).padStart(3, "0")}.png` });
  }
  return { total, timing };
}

for (const mode of MODES) {
  test(`node add ${mode.id}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await open(page, mode.reducedMotion);
    const pane = await page.locator(".react-flow__pane").boundingBox();
    if (!pane) throw new Error("no canvas");
    await page.mouse.dblclick(pane.x + 120, pane.y + pane.height - 220);
    await page.keyboard.type("standard");
    // Freeze the clock of new animations at their start the moment they are created.
    await page.keyboard.press("Enter");
    const added = node(page, "Standard node").last();
    await expect(added).toBeVisible();
    const { total } = await frames(added, `${DIR}/node-add-${mode.id}`);
    // §5.1: spring.gentle (240 ms visual); reduced motion: 80 ms opacity only, or nothing.
    if (mode.id === "normal") expect(total).toBeGreaterThan(0);
  });

  test(`card reorder ${mode.id}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await open(page, mode.reducedMotion);
    const greeting = node(page, "Greeting");
    const rows = greeting.locator("[data-card]");
    const second = await rows.nth(1).boundingBox();
    const first = await rows.nth(0).boundingBox();
    if (!first || !second) throw new Error("no card rows");
    await page.mouse.move(second.x + 40, second.y + 12);
    await page.mouse.down();
    await page.mouse.move(second.x + 40, first.y + 4, { steps: 8 });
    // Mid-drag: the lifted row and the row it displaced.
    await greeting.screenshot({ path: `${DIR}/card-reorder-${mode.id}-drag.png` });
    await page.mouse.up();
    await frames(greeting, `${DIR}/card-reorder-${mode.id}`);
  });

  for (const kind of ["connect", "reconnect"] as const) {
    test(`${kind} ${mode.id}`, async ({ page }) => {
      mkdirSync(DIR, { recursive: true });
      await open(page, mode.reducedMotion);
      const canvas = page.locator(".wk-canvas");
      const from =
        kind === "connect"
          ? node(page, "Greeting").locator('.react-flow__handle[data-handleid="next"]')
          : page.locator(".react-flow__edgeupdater-target").first();
      const to = node(page, "Hand off to a person");
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      if (!a || !b) throw new Error("not visible");
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(a.x + (b.x + 24 - a.x) * t, a.y + (b.y + b.height / 2 - a.y) * t);
        if (i === Math.round(steps / 2) || i === steps) {
          await canvas.screenshot({ path: `${DIR}/${kind}-${mode.id}-${i === steps ? "over-target" : "midway"}.png` });
        }
      }
      await page.mouse.up();
      await canvas.screenshot({ path: `${DIR}/${kind}-${mode.id}-released.png` });
    });
  }
}

// Task 2.8 (design system §5.15, §5.16): the palette opens on spring.gentle (scale 0.98 → 1 and a
// fade) and closes in 120 ms; the Issues sheet travels in from the end edge on spring.smooth.
for (const mode of MODES) {
  test(`palette open and close ${mode.id}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await open(page, mode.reducedMotion);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const opened = await frames(palette, `${DIR}/palette-open-${mode.id}`);
    expect(opened.total).toBeLessThanOrEqual(mode.id === "reduced" ? 200 : 600);
    // Let the opening run out on its own (Motion keeps its own state), then close.
    await palette.evaluate((el) => {
      for (const a of el.getAnimations({ subtree: true })) a.play();
    });
    await expect.poll(() => palette.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    await page.keyboard.press("Escape");
    const closed = await frames(palette, `${DIR}/palette-close-${mode.id}`);
    expect(closed.total).toBeLessThanOrEqual(120);
  });

  test(`issues sheet open ${mode.id}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await open(page, mode.reducedMotion, "issues");
    await page.getByRole("button", { name: /Show issues$/ }).click();
    await frames(page.getByRole("dialog", { name: "Issues" }), `${DIR}/issues-open-${mode.id}`);
  });
}

// Task 2.9 (design system §5.2): the code drawer slides up with spring.smooth; reduced motion fades.
for (const mode of MODES) {
  test(`code drawer open ${mode.id}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await open(page, mode.reducedMotion, "code");
    await page.locator(".react-flow__node [data-card] > div:first-child").nth(4).click();
    // Load Monaco first, so the frames show the drawer moving rather than the editor arriving.
    await page.getByRole("complementary").getByRole("button", { name: "Edit code" }).click();
    const drawer = page.getByRole("region", { name: /^Code of Run code in / });
    await expect(drawer.locator(".monaco-editor")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await page.getByRole("complementary").getByRole("button", { name: "Edit code" }).click();
    const { timing } = await frames(page.locator(".wk-canvas").locator(".."), `${DIR}/code-drawer-open-${mode.id}`);
    const props = timing.flatMap((t) => t.props);
    if (mode.id === "reduced") expect(props).not.toContain("transform");
    else expect(props).toContain("transform");
  });
}

test.describe("videos", () => {
  for (const mode of MODES) {
    test(`all four, real time, ${mode.id}`, async ({ browser }) => {
      mkdirSync(`${DIR}/raw`, { recursive: true });
      const context = await browser.newContext({
        reducedMotion: mode.reducedMotion,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        recordVideo: { dir: `${DIR}/raw`, size: { width: 1440, height: 900 } },
      });
      const page = await context.newPage();
      await open(page, mode.reducedMotion);
      const pane = await page.locator(".react-flow__pane").boundingBox();
      if (!pane) throw new Error("no canvas");
      await page.mouse.dblclick(pane.x + 120, pane.y + pane.height - 220);
      await page.keyboard.type("standard");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
      await page.keyboard.press("Escape");
      const rows = node(page, "Greeting").locator("[data-card]");
      const r1 = await rows.nth(1).boundingBox();
      const r0 = await rows.nth(0).boundingBox();
      if (r0 && r1) {
        await page.mouse.move(r1.x + 40, r1.y + 12);
        await page.mouse.down();
        await page.mouse.move(r1.x + 40, r0.y + 4, { steps: 20 });
        await page.mouse.up();
        await page.waitForTimeout(600);
      }
      const out = await node(page, "Greeting").locator('.react-flow__handle[data-handleid="next"]').boundingBox();
      const target = await node(page, "Hand off to a person").boundingBox();
      if (out && target) {
        await page.mouse.move(out.x + 4, out.y + 4);
        await page.mouse.down();
        await page.mouse.move(target.x + 24, target.y + target.height / 2, { steps: 30 });
        await page.mouse.up();
        await page.waitForTimeout(600);
      }
      const video = page.video();
      await context.close();
      if (video) {
        const { renameSync } = await import("node:fs");
        renameSync(await video.path(), `${DIR}/canvas-${mode.id}.webm`);
      }
    });
  }
});
