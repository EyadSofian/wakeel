import { expect, type Page, test } from "@playwright/test";
import { mockApi, WS } from "./mock-api";

/**
 * Canvas performance budget (design system §5.1) against the production build with the 300-node,
 * 450-transition fixture: open < 800 ms to interactive, selection < 50 ms, node add < 100 ms to
 * next paint, pan and zoom ≥ 55 fps average with no frame over 32 ms.
 *
 * "Mid-range laptop profile" is CPU throttling at 2× on the CI runner. Adding a card is measured
 * through the card menu (task 2.5), from Enter to the next paint with the new row.
 */
const ROUTE = `/w/${WS}/b/bot_01m7a256m0a13warwhczsjhx9b`;
const CPU_THROTTLE = 2;

test.use({ viewport: { width: 1440, height: 900 } });

async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
}

/** Frame intervals while `drive` runs, measured with requestAnimationFrame in the page. */
async function frames(page: Page, drive: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await drive();
  const intervals = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames.slice(2); // the first frames include the measurement set-up
  });
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const worst = Math.max(...intervals);
  return { fps: 1000 / avg, worst, worstAt: intervals.indexOf(worst), count: intervals.length };
}

test("300-node canvas meets the §5.1 budget", async ({ page }) => {
  test.setTimeout(120_000);
  await mockApi(page, "default", "dense-300");
  // Warm the module cache so "open" measures the workflow, not the first download of the bundle.
  await page.goto(`/w/${WS}`);
  await page.waitForLoadState("networkidle");
  await throttle(page);

  const t0 = Date.now();
  await page.goto(ROUTE);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(page.locator('[data-validated="true"]')).toBeVisible();
  const open = Date.now() - t0;

  // Selection: click a node header; time from the click to the selected class, in the page.
  const header = page.locator(".react-flow__node").nth(5).locator("header");
  const select = await header.evaluate(
    (el) =>
      new Promise<number>((resolve) => {
        const node = el.closest(".react-flow__node") as HTMLElement;
        const start = performance.now();
        new MutationObserver((_, obs) => {
          if (node.classList.contains("selected")) {
            obs.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - start));
          }
        }).observe(node, { attributes: true, attributeFilter: ["class"] });
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 1, clientY: 1 }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }),
  );

  // Pan: drag the empty pane for about a second.
  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) throw new Error("no canvas");
  const pan = await frames(page, async () => {
    await page.mouse.move(box.x + 40, box.y + box.height - 40);
    await page.mouse.down();
    for (let i = 0; i < 60; i++) await page.mouse.move(box.x + 40 + i * 8, box.y + box.height - 40 - i * 4);
    await page.mouse.up();
  });

  // Zoom: wheel in and out over the canvas.
  const zoom = await frames(page, async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, i < 15 ? -40 : 40);
  });

  // Card add (task 2.5 made it possible): open the card menu on a visible node, filter to "Log",
  // then time from Enter to the next paint after the node has one more card row.
  // At the fit (about 11%) nodes are compact and have no "Add card"; zoom to 100% first.
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByRole("toolbar", { name: "Zoom" })).toContainText("100%");
  await expect(page.locator("[data-add-card]").first()).toBeVisible();
  const visibleId = await page.evaluate(() => {
    const pane = (document.querySelector(".react-flow__pane") as HTMLElement).getBoundingClientRect();
    const inside = [...document.querySelectorAll<HTMLElement>("[data-add-card]")].find((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= pane.left && r.right <= pane.right && r.top >= pane.top + 80 && r.bottom <= pane.bottom - 80;
    });
    return inside?.dataset["addCard"];
  });
  const target = page.locator(`.react-flow__node[data-id="${visibleId}"]`);
  await target.locator("[data-add-card]").click();
  await expect(page.getByRole("dialog", { name: "Add card" })).toBeVisible();
  await page.keyboard.type("log");
  const nodeId = await target.getAttribute("data-id");
  const add = await page.evaluate(
    (id) =>
      new Promise<number>((resolve) => {
        const node = document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
        const before = node.querySelectorAll("[data-card]").length;
        const input = document.querySelector('[role="dialog"][aria-label="Add card"] input') as HTMLElement;
        const start = performance.now();
        new MutationObserver((_, obs) => {
          if (node.querySelectorAll("[data-card]").length > before) {
            obs.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - start));
          }
        }).observe(node, { childList: true, subtree: true });
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }),
    nodeId,
  );

  const report = { open, select, add, pan, zoom, throttle: CPU_THROTTLE };
  test.info().annotations.push({ type: "budget", description: JSON.stringify(report) });
  process.stdout.write(`canvas perf: ${JSON.stringify(report)}\n`);

  expect(open, "open to interactive (ms)").toBeLessThan(800);
  expect(select, "selection response (ms)").toBeLessThan(50);
  expect(add, "card add to next paint (ms)").toBeLessThan(100);
  expect(pan.fps, "pan fps").toBeGreaterThanOrEqual(55);
  expect(pan.worst, "pan worst frame (ms)").toBeLessThanOrEqual(32);
  expect(zoom.fps, "zoom fps").toBeGreaterThanOrEqual(55);
  expect(zoom.worst, "zoom worst frame (ms)").toBeLessThanOrEqual(32);
});
