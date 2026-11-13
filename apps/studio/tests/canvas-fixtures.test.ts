import { BotDefinition, validateDefinition } from "@wakeel/contracts";
import { describe, expect, it } from "vitest";
import { usageCounts } from "../src/routes/variables/model";
import { type CanvasFixture, canvasDraft, DRAFT_SCHEMA_VERSION, variablesDraft } from "./canvas-fixtures";

const definition = (kind: CanvasFixture) => {
  const d = canvasDraft(kind);
  return BotDefinition.parse({ schemaVersion: DRAFT_SCHEMA_VERSION, manifest: d.manifest, workflows: d.workflows });
};

describe("canvas review fixtures", () => {
  it.each(["typical", "rtl", "empty", "dense-300", "issues"] as const)(
    "%s parses with the contract schemas",
    (kind) => {
      expect(() => definition(kind)).not.toThrow();
    },
  );

  it.each(["typical", "rtl"] as const)("%s has no errors or warnings", (kind) => {
    expect(validateDefinition(definition(kind))).toEqual([]);
  });

  it("issues has at least one error and one warning", () => {
    const severities = new Set(validateDefinition(definition("issues")).map((i) => i.severity));
    expect(severities).toEqual(new Set(["error", "warning"]));
  });

  it("dense-300 is the §5.1 budget size: 300 nodes, 450 transitions", () => {
    const wf = definition("dense-300").workflows[0];
    expect(wf?.nodes).toHaveLength(300);
    expect(wf?.edges).toHaveLength(450);
  });

  it.each(["default", "rtl", "empty"] as const)("variables %s parses and validates clean", (kind) => {
    const d = variablesDraft(kind);
    const def = BotDefinition.parse({ schemaVersion: DRAFT_SCHEMA_VERSION, ...d });
    expect(validateDefinition(def)).toEqual([]);
  });

  it("variables: usage counts agree with findUsages", async () => {
    const { findUsages } = await import("@wakeel/contracts");
    const d = variablesDraft("default");
    const counts = usageCounts(d);
    for (const v of d.manifest.variables) {
      expect(counts.variable(v), v.name).toBe(findUsages(d, { kind: "variable", variableId: v.id }).length);
    }
    for (const wf of d.workflows) {
      for (const v of wf.variables) {
        expect(counts.variable(v, wf.id), v.name).toBe(findUsages(d, { kind: "variable", variableId: v.id }).length);
      }
      for (const kind of ["input", "output"] as const) {
        for (const f of kind === "input" ? wf.inputs : wf.outputs) {
          expect(counts.io(wf.id, kind, f.name), f.name).toBe(
            findUsages(d, { kind, workflowId: wf.id, name: f.name }).length,
          );
        }
      }
    }
    expect(counts.variable(d.manifest.variables[1] as never)).toBeGreaterThan(0);
  });
});
