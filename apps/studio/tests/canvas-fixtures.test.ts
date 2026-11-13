import { BotDefinition, validateDefinition } from "@wakeel/contracts";
import { describe, expect, it } from "vitest";
import { type CanvasFixture, canvasDraft, DRAFT_SCHEMA_VERSION } from "./canvas-fixtures";

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
});
