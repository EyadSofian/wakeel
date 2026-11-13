import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "./shortcuts";
import { HANDLED } from "./use-canvas-keyboard";

describe("shortcut table", () => {
  it("every shortcut the sheet lists is handled, and nothing handled is missing from the sheet", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id))).toEqual(HANDLED);
  });

  it("ids are unique and every row says what it does", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.action).toMatch(/^[A-Z]/);
    }
  });
});
