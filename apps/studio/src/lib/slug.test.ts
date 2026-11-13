import { describe, expect, it } from "vitest";
import { slugFrom } from "./slug";

describe("slugFrom", () => {
  it.each([
    ["Support bot", "support-bot"],
    ["  Café  Orders ", "cafe-orders"],
    ["مساعد المتجر", "msaad-almtgr"],
    ["بوت ٢٤ ساعة", "bwt-24-saaa"],
    ["Engosoft مبيعات", "engosoft-mbyaat"],
    ["مُساعِد", "msaad"],
    ["!!!", ""],
  ])("%s → %s", (name, slug) => {
    expect(slugFrom(name)).toBe(slug);
  });

  it("never ends with a dash after truncation", () => {
    const slug = slugFrom(`${"a".repeat(47)} b`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("always matches the slug pattern when not empty", () => {
    for (const name of ["مساعد المتجر", "Café", "a-b", "ال ٣"]) {
      expect(slugFrom(name)).toMatch(/^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/);
    }
  });
});
