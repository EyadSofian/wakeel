import { describe, expect, test } from "vitest";
import { clampDrawer, DRAWER, shareAfterKey, shareAtPointer } from "./drawer-size";

describe("code drawer height (design system §5.2: 60%, resizable)", () => {
  test("opens at 60% and stays between its limits", () => {
    expect(DRAWER.initial).toBe(0.6);
    expect(clampDrawer(0.05)).toBe(DRAWER.min);
    expect(clampDrawer(1.4)).toBe(DRAWER.max);
    expect(clampDrawer(0.5)).toBe(0.5);
  });

  test.each([
    // pointer y, container top, container bottom → share of the height below the pointer
    [500, 100, 900, 0.5],
    [100, 100, 900, DRAWER.max],
    [880, 100, 900, DRAWER.min],
    [400, 100, 100, DRAWER.initial],
  ])("dragging to y=%d in %d..%d gives %d", (y, top, bottom, share) => {
    expect(shareAtPointer(y, top, bottom)).toBeCloseTo(share);
  });

  test.each([
    ["ArrowUp", false, 0.65],
    ["ArrowDown", false, 0.55],
    ["ArrowUp", true, 0.8],
    ["ArrowDown", true, 0.4],
    ["Home", false, DRAWER.max],
    ["End", false, DRAWER.min],
  ])("%s (shift %s) from 60%% gives %d", (key, shift, share) => {
    expect(shareAfterKey(0.6, key, shift)).toBeCloseTo(share);
  });

  test("other keys do not resize, and steps stop at the limits", () => {
    expect(shareAfterKey(0.6, "a", false)).toBeUndefined();
    expect(shareAfterKey(DRAWER.max, "ArrowUp", false)).toBe(DRAWER.max);
    expect(shareAfterKey(DRAWER.min, "ArrowDown", true)).toBe(DRAWER.min);
  });
});
