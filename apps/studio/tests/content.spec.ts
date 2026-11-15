import { expect, test } from "@playwright/test";

/**
 * Design system §2.2 and §6, checked on computed styles rather than by eye: content whose resolved
 * direction is RTL gets line-height 1.75 and no tracking; long tokens stay inside their box.
 */
test.use({ viewport: { width: 1440, height: 900 } });

test("RTL content gets line-height 1.75, LTR keeps the token", async ({ page }) => {
  await page.goto("/__gallery");
  const style = (fixture: string) =>
    page
      .locator(`[data-fixture="${fixture}"] p`)
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          lineHeight: Number.parseFloat(s.lineHeight),
          fontSize: Number.parseFloat(s.fontSize),
          letterSpacing: s.letterSpacing,
        };
      });
  const arabic = await style("pure_arabic");
  expect(arabic.lineHeight / arabic.fontSize).toBeCloseTo(1.75, 2);
  expect(["0px", "normal"]).toContain(arabic.letterSpacing);
  const english = await style("english_arabic_name");
  expect(english.lineHeight).toBe(22);
});

test("a long unbroken token stays inside its box", async ({ page }) => {
  await page.goto("/__gallery");
  const overflow = await page
    .locator('[data-fixture="long_token"] p')
    .first()
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBe(0);
});
