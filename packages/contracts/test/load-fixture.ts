import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Reads a JSON fixture as `unknown`, so tests prove the schema accepts it rather than the compiler. */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}

/** A mutable copy of a JSON fixture for building negative cases. */
// biome-ignore lint/suspicious/noExplicitAny: negative cases reach into arbitrary paths of untyped JSON.
export const mutable = (name: string): any => structuredClone(loadFixture(name));
