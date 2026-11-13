import { describe, expect, test } from "vitest";
import { SCREENS, selectedScreens } from "./screens";

describe("review screens", () => {
  test("ids are unique and routes start with /", () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length);
    for (const s of SCREENS) expect(s.route.startsWith("/")).toBe(true);
  });

  test("every screen is shot at both review sizes (§8.1)", () => {
    for (const s of SCREENS)
      expect(s.sizes).toEqual(
        expect.arrayContaining([
          [1440, 900],
          [1280, 720],
        ]),
      );
  });

  test("--screen selects one screen and rejects unknown ids", () => {
    expect(selectedScreens("gallery").map((s) => s.id)).toEqual(["gallery"]);
    expect(selectedScreens(undefined)).toBe(SCREENS);
    expect(() => selectedScreens("nope")).toThrow(/Unknown screen "nope"/);
  });
});
