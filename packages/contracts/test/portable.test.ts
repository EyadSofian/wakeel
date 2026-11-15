import { describe, expect, test } from "vitest";
import {
  BotDefinition,
  BotExport,
  externalReferences,
  regenerateIds,
  SCHEMA_VERSION,
  seedBot,
  seedSubWorkflow,
  validateDefinition,
} from "../src/index";

/** Task 7.6: the export format, id regeneration on import, and unresolved references. */
const seeded = seedBot({ name: "متجر النور" });
const sub = seedSubWorkflow("Track order");
const def = BotDefinition.parse({
  schemaVersion: SCHEMA_VERSION,
  manifest: {
    ...seeded.manifest,
    variables: [{ id: "var_topic00001", name: "topic", scope: "conversation", type: "string", sensitive: false }],
  },
  workflows: [
    {
      ...seeded.main,
      nodes: seeded.main.nodes.map((n) =>
        n.type === "autonomous"
          ? {
              ...n,
              instructions: "ساعد العميل. المعرّف node_notAnIdXy يبقى نصاً.",
              tools: [
                {
                  id: "tool_kbsearch01",
                  type: "kb_search",
                  name: "searchPolicies",
                  description: "Search the return policy.",
                  kbIds: ["kb_01m7a256m0a13warwhczsjhx9k"],
                },
              ],
            }
          : n,
      ),
    },
    sub,
  ],
});

describe("regenerateIds", () => {
  test("every element id changes, consistently, and the result still validates the same", () => {
    const { definition: next, map } = regenerateIds(def);
    const ids = (d: BotDefinition) => [
      ...d.workflows.map((w) => w.id),
      ...d.workflows.flatMap((w) => w.nodes.map((n) => n.id)),
      ...d.workflows.flatMap((w) => w.edges.map((e) => e.id)),
      ...d.manifest.variables.map((v) => v.id),
    ];
    const before = ids(def);
    const after = ids(next);
    expect(after).toHaveLength(before.length);
    for (const [i, id] of before.entries()) {
      expect(after[i]).not.toBe(id);
      expect(map.get(id)).toBe(after[i]);
    }
    // References follow: the main workflow pointer, edge endpoints and layout keys.
    expect(next.manifest.mainWorkflowId).toBe(map.get(def.manifest.mainWorkflowId));
    const edge = next.workflows[0]?.edges[0];
    expect(next.workflows[0]?.nodes.map((n) => n.id)).toContain(edge?.from.nodeId);
    expect(Object.keys(next.workflows[0]?.layout ?? {}).sort()).toEqual(
      next.workflows[0]?.nodes.map((n) => n.id).sort(),
    );
    // Builder text that only looks like an id is left alone; Arabic is kept byte for byte.
    const agent = next.workflows[0]?.nodes.find((n) => n.type === "autonomous");
    expect(agent?.type === "autonomous" && agent.instructions).toBe("ساعد العميل. المعرّف node_notAnIdXy يبقى نصاً.");
    expect(validateDefinition(next).map((i) => i.code)).toEqual(validateDefinition(def).map((i) => i.code));
  });

  test("mapping the new ids back gives the original definition", () => {
    const { definition: next, map } = regenerateIds(def);
    const back = new Map([...map].map(([a, b]) => [b, a]));
    let json = JSON.stringify(next);
    for (const [from, to] of back) json = json.split(from).join(to);
    expect(JSON.parse(json)).toEqual(def);
  });
});

describe("externalReferences", () => {
  test("lists knowledge bases and tables the definition names, once each", () => {
    expect(externalReferences(def)).toEqual([{ kind: "knowledge_base", id: "kb_01m7a256m0a13warwhczsjhx9k" }]);
  });
});

describe("BotExport", () => {
  test("parses its own format and refuses others", () => {
    const file = { format: "wakeel.bot", formatVersion: 1, exportedAt: "2026-11-15T10:00:00.000Z", definition: def };
    expect(BotExport.safeParse(file).success).toBe(true);
    expect(BotExport.safeParse({ ...file, format: "botpress" }).success).toBe(false);
    expect(BotExport.safeParse({ ...file, formatVersion: 2 }).success).toBe(false);
  });
});
