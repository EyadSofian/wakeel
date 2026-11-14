import {
  BotDefinition,
  type ConversationState,
  emptyState,
  SCHEMA_VERSION,
  seedBot,
  type Variable,
} from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import { migrateToVersion } from "../src/turn/version";

/** Task 7.2: what a conversation keeps when the published version changes (architecture §3.2). */
const seeded = seedBot({ name: "متجر" });
const vars: Variable[] = [
  { id: "var_topic00001", name: "topic", scope: "conversation", type: "string", sensitive: false },
  { id: "var_count00001", name: "count", scope: "conversation", type: "number", sensitive: false },
  { id: "var_plan000001", name: "plan", scope: "user", type: "enum", enumValues: ["basic", "pro"], sensitive: false },
];

function definition(variables: Variable[], keepNode = true): BotDefinition {
  const main = keepNode ? seeded.main : { ...seeded.main, nodes: seeded.main.nodes.filter((n) => n.type === "start") };
  return BotDefinition.parse({
    schemaVersion: SCHEMA_VERSION,
    manifest: { ...seeded.manifest, variables },
    workflows: [{ ...main, edges: keepNode ? main.edges : [] }],
  });
}

const agent = seeded.main.nodes.find((n) => n.type === "autonomous");
if (!agent) throw new Error("the seeded bot has no autonomous node");

const waiting: ConversationState = {
  ...emptyState(),
  status: "waiting_input",
  stack: [{ workflowId: seeded.main.id, nodeId: agent.id, cardIndex: 0, vars: {}, inputs: {} }],
  wait: { kind: "listen", nodeId: agent.id, since: "2026-11-14T10:00:00.000Z" },
  conversationVars: { var_topic00001: "طلب", var_count00001: 3 },
  autonomy: { [`${seeded.main.id}:${agent.id}`]: { iteration: 1, memo: { step: 2 }, feedback: [] } },
};

describe("migrateToVersion", () => {
  test("every stack position still exists: the conversation carries on unchanged", () => {
    const m = migrateToVersion({
      state: waiting,
      userVars: { var_plan000001: "pro" },
      next: definition(vars),
      previous: definition(vars),
    });
    expect(m.positionKept).toBe(true);
    expect(m.state).toEqual(waiting);
    expect(m.userVars).toEqual({ var_plan000001: "pro" });
    expect(m.dropped).toEqual([]);
  });

  test("a node on the stack is gone: the stack resets and only variables that still validate are kept", () => {
    // The new version drops `count`, makes `topic` a number, and keeps `plan` but without "pro".
    const next: Variable[] = [
      { id: "var_topic00001", name: "topic", scope: "conversation", type: "number", sensitive: false },
      { id: "var_plan000001", name: "plan", scope: "user", type: "enum", enumValues: ["basic"], sensitive: false },
      { id: "var_lang000001", name: "lang", scope: "user", type: "string", sensitive: false },
    ];
    const m = migrateToVersion({
      state: waiting,
      userVars: { var_plan000001: "basic", var_old0000001: "x" },
      next: definition(next, false),
      previous: definition(vars),
    });
    expect(m.positionKept).toBe(false);
    expect(m.state.status).toBe("idle");
    expect(m.state.stack).toEqual([]);
    expect(m.state.wait).toBeUndefined();
    expect(m.state.autonomy).toEqual({});
    expect(m.state.conversationVars).toEqual({});
    expect(m.userVars).toEqual({ var_plan000001: "basic" });
    expect(m.dropped).toEqual([
      { scope: "conversation", id: "var_topic00001", name: "topic" },
      { scope: "conversation", id: "var_count00001", name: "count" },
      { scope: "user", id: "var_old0000001", name: "var_old0000001" },
    ]);
  });

  test("an idle conversation keeps its position trivially", () => {
    const idle = { ...emptyState(), conversationVars: { var_count00001: 1 } };
    const m = migrateToVersion({ state: idle, userVars: {}, next: definition([]) });
    expect(m.positionKept).toBe(true);
    expect(m.state.conversationVars).toEqual({ var_count00001: 1 });
  });

  test("a handed-off conversation stays handed off when its stack is reset", () => {
    const m = migrateToVersion({
      state: { ...waiting, status: "handed_off" },
      userVars: {},
      next: definition(vars, false),
    });
    expect(m.positionKept).toBe(false);
    expect(m.state.status).toBe("handed_off");
    expect(m.state.stack).toEqual([]);
  });
});
