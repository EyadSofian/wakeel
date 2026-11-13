import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as contracts from "../src/index";
import { ELEMENT_PREFIXES, ENTITY_PREFIXES, elementId, entityId, newElementId, newId } from "../src/index";

const commonSource = readFileSync(fileURLToPath(new URL("../src/common.ts", import.meta.url)), "utf8");
const declared = (fn: "entityId" | "elementId") =>
  [...commonSource.matchAll(new RegExp(`=\\s*${fn}\\("([a-z]+)"\\)`, "g"))].map((m) => m[1]);

describe("prefix lists match common.ts", () => {
  test("entity prefixes", () => {
    expect([...ENTITY_PREFIXES].sort()).toEqual(declared("entityId").sort());
  });
  test("element prefixes", () => {
    expect([...ELEMENT_PREFIXES].sort()).toEqual(declared("elementId").sort());
  });
});

describe("newId", () => {
  test.each(ENTITY_PREFIXES)("%s ids match the entity id regex", (prefix) => {
    for (let i = 0; i < 200; i++) expect(entityId(prefix).safeParse(newId(prefix)).success).toBe(true);
  });

  test("ids are valid for the exported schemas", () => {
    expect(contracts.ConversationId.safeParse(newId("conv")).success).toBe(true);
    expect(contracts.MessageId.safeParse(newId("msg")).success).toBe(true);
  });

  test("the time part encodes the clock and sorts by it", () => {
    const t0 = Date.UTC(2026, 10, 13, 9, 0, 0);
    const a = newId("msg", { now: t0 });
    const b = newId("msg", { now: t0 + 1 });
    const c = newId("msg", { now: t0 + 86_400_000 });
    expect(a.slice(0, 14)).toBe("msg_01m7a256m0");
    expect([c, a, b].sort()).toEqual([a, b, c]);
  });

  test("the epoch and the largest time encode at the ends of the range", () => {
    expect(newId("evt", { now: 0 }).slice(4, 14)).toBe("0000000000");
    expect(newId("evt", { now: 2 ** 48 - 1 }).slice(4, 14)).toBe("7zzzzzzzzz");
  });

  test.each([-1, 2 ** 48, 1.5, Number.NaN])("rejects time %s", (now) => {
    expect(() => newId("evt", { now })).toThrow(RangeError);
  });

  test("ids created in the same millisecond differ", () => {
    const now = Date.UTC(2026, 0, 1);
    const ids = new Set(Array.from({ length: 5_000 }, () => newId("row", { now })));
    expect(ids.size).toBe(5_000);
  });

  test("random characters cover the whole Crockford alphabet and nothing else", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) for (const ch of newId("doc").slice(14)) seen.add(ch);
    expect([...seen].sort().join("")).toBe("0123456789abcdefghjkmnpqrstvwxyz");
  });
});

describe("newElementId", () => {
  test.each(ELEMENT_PREFIXES)("%s ids match the element id regex", (prefix) => {
    for (let i = 0; i < 200; i++) expect(elementId(prefix).safeParse(newElementId(prefix)).success).toBe(true);
  });

  test("ids are unique and use all 62 characters", () => {
    const ids = Array.from({ length: 5_000 }, () => newElementId("card"));
    expect(new Set(ids).size).toBe(ids.length);
    const seen = new Set(ids.flatMap((id) => [...id.slice(5)]));
    expect(seen.size).toBe(62);
  });
});
