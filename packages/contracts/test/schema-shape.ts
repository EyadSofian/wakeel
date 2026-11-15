/**
 * Reduces a JSON Schema (from the OpenAPI file or from `z.toJSONSchema`) to the parts the
 * agreement test compares: property names, required lists, enums, constants, scalar types, and
 * the discriminators of unions. Lengths, patterns and descriptions are deliberately ignored: the
 * OpenAPI file documents the wire format, zod may be stricter.
 */

type Js = Record<string, unknown>;

export type Shape =
  | { kind: "object"; props: Record<string, Shape>; required: string[] }
  | { kind: "map" }
  | { kind: "array"; items: Shape }
  | { kind: "enum"; values: string[] }
  | { kind: "const"; value: unknown }
  | { kind: "union"; discriminators: string[] }
  | { kind: "scalar"; type: string }
  | { kind: "any" };

const isObj = (v: unknown): v is Js => typeof v === "object" && v !== null && !Array.isArray(v);

/** Resolves `$ref` against `root` (`#/components/schemas/X` or `#/$defs/X`) and merges `allOf`. */
function resolve(node: Js, root: Js): Js {
  let current = node;
  const ref = current["$ref"];
  if (typeof ref === "string") {
    const target = ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((acc, key) => (isObj(acc) ? acc[key] : undefined), root);
    if (!isObj(target)) throw new Error(`Unresolved $ref ${ref}`);
    current = resolve(target, root);
  }
  const allOf = current["allOf"];
  if (Array.isArray(allOf)) {
    const merged: Js = { type: "object", properties: {}, required: [] };
    for (const part of allOf) {
      const r = resolve(part as Js, root);
      merged["properties"] = { ...(merged["properties"] as Js), ...((r["properties"] as Js) ?? {}) };
      merged["required"] = [...new Set([...(merged["required"] as string[]), ...((r["required"] as string[]) ?? [])])];
    }
    current = merged;
  }
  return current;
}

export function toShape(node: unknown, root: Js): Shape {
  if (!isObj(node)) return { kind: "any" };
  const s = resolve(node, root);

  if ("const" in s) return { kind: "const", value: s["const"] };
  if (Array.isArray(s["enum"])) return { kind: "enum", values: (s["enum"] as unknown[]).map(String).sort() };

  const members = (s["oneOf"] ?? s["anyOf"]) as unknown[] | undefined;
  if (Array.isArray(members)) {
    // Read each member's `type` const directly; recursing would loop on self-referencing schemas (Json).
    const discriminators = members.map((m) => {
      const props = isObj(m) ? resolve(m, root)["properties"] : undefined;
      const type = isObj(props) && isObj(props["type"]) ? props["type"] : undefined;
      return type && "const" in type ? String(type["const"]) : "";
    });
    // Unions without a `type` discriminator (Json, nullable scalars) carry no field contract.
    return discriminators.every((d) => d !== "")
      ? { kind: "union", discriminators: discriminators.sort() }
      : { kind: "any" };
  }

  const type = Array.isArray(s["type"]) ? (s["type"] as string[]).filter((t) => t !== "null") : [s["type"]];
  if (type.length !== 1 || type[0] === undefined) return { kind: "any" };
  const t = type[0] as string;

  if (t === "object") {
    const props = s["properties"];
    if (!isObj(props)) return { kind: "map" };
    return {
      kind: "object",
      props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toShape(v, root)])),
      required: [...((s["required"] as string[]) ?? [])].sort(),
    };
  }
  if (t === "array") return { kind: "array", items: toShape(s["items"], root) };
  return { kind: "scalar", type: t };
}

/** Differences between two shapes, one sentence each; empty when they agree. */
export function compareShapes(zod: Shape, api: Shape, path = "$", allowed: Set<string> = new Set()): string[] {
  if (allowed.has(path)) return [];
  if (zod.kind === "any" || api.kind === "any") return [];
  if (zod.kind !== api.kind) {
    // A zod enum documented as a plain string in OpenAPI is a deliberate open set only when allow-listed.
    return [`${path}: zod is ${zod.kind}, OpenAPI is ${api.kind}`];
  }
  const out: string[] = [];
  switch (zod.kind) {
    case "object": {
      const a = api as Extract<Shape, { kind: "object" }>;
      const zKeys = Object.keys(zod.props).sort();
      const aKeys = Object.keys(a.props).sort();
      for (const k of zKeys) if (!aKeys.includes(k)) out.push(`${path}.${k}: in zod, missing from OpenAPI`);
      for (const k of aKeys) if (!zKeys.includes(k)) out.push(`${path}.${k}: in OpenAPI, missing from zod`);
      if (zod.required.join() !== a.required.join()) {
        out.push(`${path}: required differs (zod [${zod.required.join(", ")}], OpenAPI [${a.required.join(", ")}])`);
      }
      for (const k of zKeys) {
        const zp = zod.props[k];
        const ap = a.props[k];
        if (zp && ap) out.push(...compareShapes(zp, ap, `${path}.${k}`, allowed));
      }
      break;
    }
    case "array":
      out.push(...compareShapes(zod.items, (api as Extract<Shape, { kind: "array" }>).items, `${path}[]`, allowed));
      break;
    case "enum": {
      const a = (api as Extract<Shape, { kind: "enum" }>).values;
      if (zod.values.join() !== a.join()) out.push(`${path}: enum differs (zod [${zod.values}], OpenAPI [${a}])`);
      break;
    }
    case "const": {
      const a = (api as Extract<Shape, { kind: "const" }>).value;
      if (zod.value !== a) out.push(`${path}: const differs (zod ${String(zod.value)}, OpenAPI ${String(a)})`);
      break;
    }
    case "union": {
      const a = (api as Extract<Shape, { kind: "union" }>).discriminators;
      if (zod.discriminators.join() !== a.join()) {
        out.push(`${path}: union members differ (zod [${zod.discriminators}], OpenAPI [${a}])`);
      }
      break;
    }
    case "scalar": {
      const a = (api as Extract<Shape, { kind: "scalar" }>).type;
      if (zod.type !== a) out.push(`${path}: type differs (zod ${zod.type}, OpenAPI ${a})`);
      break;
    }
    case "map":
      break;
  }
  return out;
}
