import type { DefinitionIssue } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { seededDraft } from "../canvas/store/fixtures.test-utils";
import { issueKey, issueLocation, orderIssues, stepIssue } from "./issue-order";

const issue = (severity: "error" | "warning", path: string, at: Partial<DefinitionIssue> = {}): DefinitionIssue => ({
  severity,
  code: "instructions_empty" as DefinitionIssue["code"],
  message: path,
  fix: "Fix it.",
  path,
  workflowId: "wf_1",
  ...at,
});

describe("orderIssues and stepIssue", () => {
  const list = orderIssues([
    issue("warning", "w1"),
    issue("error", "e1"),
    issue("warning", "w2"),
    issue("error", "e2"),
    issue("error", "manifest.settings", { workflowId: undefined }),
  ]);

  test("errors first, then warnings, each in validator order", () => {
    expect(list.map((i) => i.path)).toEqual(["e1", "e2", "manifest.settings", "w1", "w2"]);
  });

  test("F8 walks forward and wraps; ⇧F8 walks back; bot-level issues are skipped", () => {
    const walk = (dir: 1 | -1, steps: number) => {
      const seen: string[] = [];
      let key: string | undefined;
      for (let n = 0; n < steps; n++) {
        const next = stepIssue(list, key, dir);
        if (!next) break;
        seen.push(next.path);
        key = issueKey(next);
      }
      return seen;
    };
    expect(walk(1, 5)).toEqual(["e1", "e2", "w1", "w2", "e1"]);
    expect(walk(-1, 3)).toEqual(["w2", "w1", "e2"]);
  });

  test("a key that is gone (the issue was fixed) starts over", () => {
    expect(stepIssue(list, "gone:x", 1)?.path).toBe("e1");
    expect(stepIssue([], undefined, 1)).toBeUndefined();
  });
});

describe("issueLocation", () => {
  test("workflow › node › card, or bot settings", () => {
    const { main } = seededDraft();
    const agent = main.nodes[1];
    expect(issueLocation(issue("error", "x", { workflowId: main.id, nodeId: agent?.id }), { [main.id]: main })).toBe(
      "Main › Assistant",
    );
    expect(issueLocation(issue("error", "x", { workflowId: undefined }), {})).toBe("Bot settings");
  });
});
