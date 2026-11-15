import { describe, expect, test } from "vitest";
import { checkJsonSchema, JSON_SCHEMA_MAX_DEPTH, validateJson } from "../src/index";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("checkJsonSchema accepts", () => {
  test.each([
    ["an empty schema", {}],
    ["a string with every string keyword", { type: "string", minLength: 1, maxLength: 20, format: "email" }],
    ["a nullable number range", { type: ["number", "null"], minimum: 0, maximum: 100 }],
    [
      "a nested object",
      {
        type: "object",
        description: "عنوان التوصيل",
        properties: {
          city: { type: "string", enum: ["القاهرة", "الجيزة"] },
          lines: { type: "array", items: { type: "string", maxLength: 200 } },
        },
        required: ["city"],
      },
    ],
    ["an enum without a type", { enum: ["a", 1, null, { x: 1 }] }],
  ])("%s", (_name, schema) => {
    expect(checkJsonSchema(schema)).toEqual([]);
  });
});

describe("checkJsonSchema rejects", () => {
  test.each([
    ["a non-object schema", [], "schema_not_object", ""],
    [
      "a keyword outside the subset",
      { type: "object", additionalProperties: false },
      "unsupported_keyword",
      "additionalProperties",
    ],
    ["$ref", { $ref: "#/x" }, "unsupported_keyword", "$ref"],
    ["an unknown type", { type: "date" }, "invalid_type_name", "type"],
    ["an empty type list", { type: [] }, "invalid_keyword_value", "type"],
    ["a repeated type", { type: ["string", "string"] }, "duplicate_value", "type"],
    ["minLength on a number", { type: "number", minLength: 2 }, "keyword_not_applicable", "minLength"],
    ["items on an object", { type: "object", items: {} }, "keyword_not_applicable", "items"],
    [
      "required naming a missing property",
      { type: "object", properties: {}, required: ["id"] },
      "required_unknown_property",
      "required",
    ],
    ["required that is not a list of names", { type: "object", required: "id" }, "invalid_keyword_value", "required"],
    ["an empty enum", { enum: [] }, "invalid_keyword_value", "enum"],
    [
      "a repeated enum value",
      {
        enum: [
          { a: 1, b: 2 },
          { b: 2, a: 1 },
        ],
      },
      "duplicate_value",
      "enum",
    ],
    ["minimum above maximum", { type: "integer", minimum: 5, maximum: 1 }, "range_inverted", ""],
    ["a negative maxLength", { type: "string", maxLength: -1 }, "invalid_keyword_value", "maxLength"],
    ["a fractional minLength", { type: "string", minLength: 1.5 }, "invalid_keyword_value", "minLength"],
    ["an infinite maximum", { type: "number", maximum: Number.POSITIVE_INFINITY }, "invalid_keyword_value", "maximum"],
    ["an unsupported format", { type: "string", format: "ipv4" }, "unsupported_format", "format"],
    ["a description that is not text", { description: 3 }, "invalid_keyword_value", "description"],
    [
      "a property schema that is not an object",
      { type: "object", properties: { a: "string" } },
      "schema_not_object",
      "properties.a",
    ],
    [
      "a nested problem",
      { type: "array", items: { type: "object", properties: { a: { type: "uuid" } } } },
      "invalid_type_name",
      "items.properties.a.type",
    ],
  ])("%s", (_name, schema, code, path) => {
    const issues = checkJsonSchema(schema);
    expect(issues).toContainEqual(expect.objectContaining({ code, path }));
    for (const i of issues) expect(i.message).not.toMatch(/\{\w+\}/);
  });

  test("nesting past the depth limit", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i <= JSON_SCHEMA_MAX_DEPTH; i++) schema = { type: "array", items: schema };
    expect(codes(checkJsonSchema(schema))).toContain("too_deep");
  });

  test("messages are filled in", () => {
    expect(checkJsonSchema({ type: "string", format: "ipv4" })[0]?.message).toBe(
      'Format "ipv4" is not supported; use one of: date-time, date, time, email, uri',
    );
  });
});

describe("validateJson", () => {
  const order = {
    type: "object",
    properties: {
      orderId: { type: "string", minLength: 5, maxLength: 10 },
      quantity: { type: "integer", minimum: 1, maximum: 99 },
      city: { type: "string", enum: ["القاهرة", "الجيزة"] },
      email: { type: "string", format: "email" },
      placedAt: { type: "string", format: "date-time" },
      items: { type: "array", items: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } },
      note: { type: ["string", "null"] },
    },
    required: ["orderId", "quantity"],
  };

  test("a valid value with Arabic text and an unlisted property", () => {
    const value = {
      orderId: "45123",
      quantity: 2,
      city: "القاهرة",
      email: "mona@example.com",
      placedAt: "2026-11-13T09:00:00+02:00",
      items: [{ sku: "A-1" }],
      note: null,
      extra: true,
    };
    expect(checkJsonSchema(order)).toEqual([]);
    expect(validateJson(order, value)).toEqual([]);
  });

  test.each([
    ["a missing required property", { quantity: 1 }, "required", "orderId"],
    ["a number where a string is expected", { orderId: 45123, quantity: 1 }, "type_mismatch", "orderId"],
    ["a fraction for an integer", { orderId: "45123", quantity: 1.5 }, "type_mismatch", "quantity"],
    ["a value below the minimum", { orderId: "45123", quantity: 0 }, "too_small", "quantity"],
    ["a value above the maximum", { orderId: "45123", quantity: 100 }, "too_big", "quantity"],
    ["a string that is too short", { orderId: "451", quantity: 1 }, "too_short", "orderId"],
    ["a string that is too long", { orderId: "45123456789", quantity: 1 }, "too_long", "orderId"],
    ["a value outside the enum", { orderId: "45123", quantity: 1, city: "Cairo" }, "enum_mismatch", "city"],
    ["a bad email", { orderId: "45123", quantity: 1, email: "mona@" }, "format_mismatch", "email"],
    [
      "a date-time without an offset",
      { orderId: "45123", quantity: 1, placedAt: "2026-11-13T09:00:00" },
      "format_mismatch",
      "placedAt",
    ],
    ["a bad array item", { orderId: "45123", quantity: 1, items: [{ sku: "A" }, {}] }, "required", "items.1.sku"],
    ["an array where an object is expected", [], "type_mismatch", ""],
  ])("%s", (_name, value, code, path) => {
    expect(validateJson(order, value)).toContainEqual(expect.objectContaining({ code, path }));
  });

  test("string length counts code points, not UTF-16 units", () => {
    const schema = { type: "string", maxLength: 3 };
    expect(validateJson(schema, "مصر")).toEqual([]);
    expect(validateJson(schema, "😀😀😀")).toEqual([]);
    expect(codes(validateJson(schema, "😀😀😀😀"))).toEqual(["too_long"]);
  });

  test("NaN and Infinity are not numbers", () => {
    expect(codes(validateJson({ type: "number" }, Number.NaN))).toEqual(["type_mismatch"]);
    expect(codes(validateJson({ type: "number" }, Number.POSITIVE_INFINITY))).toEqual(["type_mismatch"]);
  });

  test("enum compares objects by value, ignoring key order", () => {
    expect(validateJson({ enum: [{ a: 1, b: [2] }] }, { b: [2], a: 1 })).toEqual([]);
  });

  test.each([
    ["date", "2026-11-13", "2026-13-01"],
    ["time", "09:30:00", "25:00:00"],
    ["uri", "https://example.com/a?b=1", "not a url"],
  ])("format %s", (format, good, bad) => {
    const schema = { type: "string", format };
    expect(validateJson(schema, good)).toEqual([]);
    expect(codes(validateJson(schema, bad))).toEqual(["format_mismatch"]);
  });
});
