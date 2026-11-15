import { type Column, newElementId } from "@wakeel/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, test } from "vitest";
import { compileRowFilter } from "../src/tables/filter";

const column = {
  id: newElementId("col"),
  name: "order",
  type: "string",
  required: false,
  unique: false,
  searchable: false,
} satisfies Column;
const dialect = new PgDialect();

test("parameterises column IDs and Arabic, mixed-direction and punctuation values", () => {
  const baseline = dialect.sqlToQuery(compileRowFilter([column], { order: { contains: "reference" } })).sql;
  const variants = ["القاهرة", "طلب ORD-12", "سعر % و _", "apostrophe's", "سطر\nجديد", "🌍"];
  for (let i = 0; i < 60; i++) {
    for (const value of variants) {
      const sample = `${value} ${i}`;
      const query = dialect.sqlToQuery(compileRowFilter([column], { order: { contains: sample } }));
      expect(query.sql).toBe(baseline);
      expect(query.params).toEqual([column.id, sample]);
    }
  }
});

test("rejects unknown columns, type mismatches and empty expressions", () => {
  for (const value of [
    { unknown: { eq: "x" } },
    { order: { eq: 7 } },
    {},
    { not: {} },
    { order: { eq: "x", extra: "y" } },
  ]) {
    expect(() => compileRowFilter([column], value)).toThrow();
  }
});
