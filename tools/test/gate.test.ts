import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { aiLayerCheck, isAiLayerFile } from "../ai-layer-check";
import { readSide } from "../evals-gate";

/** ADR-056, task 12.5: which PRs need a gate report, and how a measured folder is read. */

const REPORT = [
  "## Gate report (ADR-056)",
  "",
  "| Gate | Base | Candidate | Bar | Result |",
  "| --- | --- | --- | --- | --- |",
  "| G1 Retrieval | lowest 93.0% | lowest 95.0% | … | pass: every slice meets the bar |",
  "| G6 Cost per reply | $0.00100 | $0.00110 | … | pass: +10.0% |",
].join("\n");

describe("the ai-layer check", () => {
  test.each([
    ["packages/autonomy/src/engine.ts", true],
    ["packages/retrieval/src/search.ts", true],
    ["packages/llm/src/models.json", true],
    ["packages/engine/src/cards/ai-branch.ts", true],
    ["packages/engine/src/cards/kb-search.ts", true],
    ["apps/worker/src/turn/autonomy.ts", true],
    ["apps/worker/src/kb/index.ts", true],
    ["packages/engine/src/cards/branch.ts", false],
    ["apps/studio/src/App.tsx", false],
    ["docs/adr/055-autonomy-auto-search.md", false],
  ])("%s is AI layer: %s", (path, expected) => {
    expect(isAiLayerFile(path)).toBe(expected);
  });

  test("a PR outside the AI layer needs nothing", () => {
    expect(aiLayerCheck({ files: ["apps/studio/src/App.tsx"], body: "", labels: [] })).toEqual({
      aiLayer: false,
      ok: true,
      reasons: [],
    });
  });

  test("an AI-layer PR without a report fails and says what to paste", () => {
    const result = aiLayerCheck({ files: ["packages/autonomy/src/engine.ts"], body: "Fixes a thing.", labels: [] });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("pnpm evals:gate compare");
  });

  test("a report with a failing gate fails; one with only passing or unmeasured gates passes", () => {
    const files = ["packages/retrieval/src/search.ts"];
    expect(aiLayerCheck({ files, body: REPORT, labels: [] }).ok).toBe(true);
    const failing = `${REPORT}\n| G3 Protocol | … | gpt-6-luna 92.1% | … | **fail**: below the bar |`;
    const result = aiLayerCheck({ files, body: failing, labels: [] });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("G3 Protocol");
  });

  test("a cost rise needs the cost-approved label", () => {
    const files = ["packages/llm/src/client.ts"];
    const body = `${REPORT}\n| G6 Cost per reply | $0.001 | $0.0015 | … | **needs approval**: +50.0% |`;
    expect(aiLayerCheck({ files, body, labels: [] }).ok).toBe(false);
    expect(aiLayerCheck({ files, body, labels: ["cost-approved"] }).ok).toBe(true);
  });
});

describe("readSide", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reads every report present and leaves the rest out, so the gate says not measured", () => {
    dir = mkdtempSync(join(tmpdir(), "gate-side-"));
    writeFileSync(
      join(dir, "retrieval-realistic.json"),
      JSON.stringify({ slices: [{ slice: "table", count: 40, hybrid: { recallAt5: 0.9, mrr: 0.8 } }] }),
    );
    mkdirSync(join(dir, "adherence"));
    writeFileSync(
      join(dir, "adherence", "gpt-6-luna.json"),
      JSON.stringify({ model: "gpt-6-luna", summary: { total: 240, protocolValid: 221 } }),
    );
    // A blocked run (no credits) has no summary and is not a measurement.
    writeFileSync(
      join(dir, "adherence", "claude-sonnet-5-5.json"),
      JSON.stringify({ model: "claude-sonnet-5-5", status: "blocked" }),
    );
    const side = readSide(dir);
    expect(side.realistic?.slices[0]?.slice).toBe("table");
    expect(side.adherence?.map((a) => a.model)).toEqual(["gpt-6-luna"]);
    expect(side.synthetic).toBeUndefined();
    expect(side.bots).toBeUndefined();
  });
});
