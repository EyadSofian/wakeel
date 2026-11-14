import { z } from "zod";
import { BotDefinition } from "./bot-definition";
import { ELEMENT_PREFIXES, type ElementPrefix, newElementId } from "./ids";

/**
 * Bot export and import (task 7.6, ADR-038). An export is the draft as one definition in a small
 * envelope; an import creates a new bot from it with every element id regenerated, so two copies of
 * a bot never share ids. Knowledge bases and tables are live resources of a workspace (ADR-006),
 * so an import only reports which ones the definition names.
 */

export const BotExport = z.object({
  format: z.literal("wakeel.bot"),
  formatVersion: z.literal(1),
  exportedAt: z.iso.datetime({ offset: true }),
  definition: BotDefinition,
});
export type BotExport = z.infer<typeof BotExport>;

const ELEMENT_ID = new RegExp(`^(${ELEMENT_PREFIXES.join("|")})_[0-9A-Za-z]{10}$`);

/** Ids the definition declares: the `id` of every workflow, node, card, edge, variable, tool, exit and branch. */
function declaredIds(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const v of value) declaredIds(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "id" && typeof v === "string" && ELEMENT_ID.test(v)) out.add(v);
      else declaredIds(v, out);
    }
  }
  return out;
}

/** Replaces every id in `map` wherever it appears in a string: values, keys and port ids such as `card:<id>:failed`. */
function replaceIds(value: unknown, map: ReadonlyMap<string, string>, pattern: RegExp): unknown {
  if (typeof value === "string") return value.replace(pattern, (id) => map.get(id) ?? id);
  if (Array.isArray(value)) return value.map((v) => replaceIds(v, map, pattern));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(pattern, (id) => map.get(id) ?? id),
        replaceIds(v, map, pattern),
      ]),
    );
  }
  return value;
}

/**
 * A copy of `def` with a new id for every element it declares, applied everywhere the old id was
 * used. Only declared ids are replaced, so builder text that merely looks like an id stays as it is.
 * Returns the old → new map too.
 */
export function regenerateIds(def: BotDefinition): { definition: BotDefinition; map: Map<string, string> } {
  const ids = [...declaredIds(def, new Set())];
  const map = new Map(ids.map((id) => [id, newElementId(id.slice(0, id.indexOf("_")) as ElementPrefix)]));
  if (ids.length === 0) return { definition: def, map };
  const escaped = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(?<![0-9A-Za-z_])(${escaped.join("|")})(?![0-9A-Za-z_])`, "g");
  return { definition: BotDefinition.parse(replaceIds(def, map, pattern)), map };
}

export interface ExternalReference {
  kind: "knowledge_base" | "table";
  id: string;
}

/** Knowledge bases and tables the definition names (cards and tools), each once, in first-seen order. */
export function externalReferences(def: BotDefinition): ExternalReference[] {
  const seen = new Map<string, ExternalReference>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k === "kbIds" && Array.isArray(v)) {
          for (const id of v) if (typeof id === "string" && !seen.has(id)) seen.set(id, { kind: "knowledge_base", id });
        } else if (k === "tableId" && typeof v === "string") {
          if (!seen.has(v)) seen.set(v, { kind: "table", id: v });
        } else walk(v);
      }
    }
  };
  walk(def);
  return [...seen.values()];
}
