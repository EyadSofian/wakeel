import type { Frame, WaitSpec } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  capture,
  cardId,
  definition,
  edge,
  event,
  failures,
  nodeId,
  outcome,
  run,
  say,
  scripted,
  standard,
  state,
  step,
  texts,
  varId,
  workflow,
} from "./harness";

/**
 * ADR-025: the emulator's "Run from here" is an internal `run_from { workflowId, nodeId }` event.
 * In any state it clears the stack and the wait, pushes a frame at that node and runs.
 */

/** Main: Start → Greet → Ask (a capture card) → Thanks; and a sub-workflow with one node. */
function threeNodeBot() {
  const start = nodeId();
  const greet = nodeId();
  const ask = nodeId();
  const thanks = nodeId();
  const greetCard = cardId();
  const askCard = cardId();
  const thanksCard = cardId();
  const name = varId();
  const main = workflow({
    nodes: [
      { id: start, type: "start", name: "Start" },
      standard(greet, [step(greetCard)], "Greet"),
      standard(ask, [capture(askCard, name)], "Ask"),
      standard(thanks, [step(thanksCard)], "Thanks"),
    ],
    edges: [edge(start, "next", greet), edge(greet, "next", ask), edge(ask, "next", thanks)],
  });
  const subNode = nodeId();
  const subCard = cardId();
  const sub = workflow({
    kind: "sub",
    nodes: [{ id: nodeId(), type: "entry", name: "Entry" }, standard(subNode, [step(subCard)], "Sub step")],
  });
  const def = definition({
    workflows: [main, sub],
    variables: [{ id: name, name: "name", scope: "conversation", type: "string" }],
  });
  const behaviours = {
    [greetCard]: () => say("أهلاً"),
    [askCard]: () =>
      outcome({
        type: "wait",
        wait: { kind: "capture", nodeId: ask, cardId: askCard, attempts: 0, since: "2026-11-14T09:00:00.000Z" },
      }),
    [thanksCard]: () => say("شكراً"),
    [subCard]: () => say("من الـ sub"),
  };
  return { def, main, sub, start, greet, ask, thanks, askCard, subNode, behaviours };
}

const runFrom = (workflowId: string, nodeId: string) => event("run_from", { payload: { workflowId, nodeId } });

describe("run_from", () => {
  test("in idle runs from the node, skipping what comes before it", async () => {
    const b = threeNodeBot();
    const s = scripted(b.behaviours);
    const { result, commits } = await run({
      def: b.def,
      state: state(),
      event: runFrom(b.main.id, b.thanks),
      executors: s.executors,
    });
    expect(texts(commits)).toEqual(["شكراً"]);
    expect(result.status).toBe("completed");
    expect(result.state.stack).toEqual([]);
  });

  test("runs into a wait like any other turn", async () => {
    const b = threeNodeBot();
    const s = scripted(b.behaviours);
    const { result } = await run({
      def: b.def,
      state: state(),
      event: runFrom(b.main.id, b.ask),
      executors: s.executors,
    });
    expect(result.status).toBe("waiting");
    expect(result.state.wait).toMatchObject({ kind: "capture", nodeId: b.ask, cardId: b.askCard });
  });

  test.each(["waiting_input", "handed_off", "ended"] as const)(
    "in %s clears the stack and the wait, then runs from the node",
    async (status) => {
      const b = threeNodeBot();
      const wait: WaitSpec = {
        kind: "capture",
        nodeId: b.ask,
        cardId: b.askCard,
        attempts: 1,
        since: "2026-11-14T08:00:00.000Z",
      };
      const frame: Frame = { workflowId: b.main.id, nodeId: b.ask, cardIndex: 0, vars: {}, inputs: {} };
      const before = state({ status, stack: [frame], ...(status === "waiting_input" ? { wait } : {}) });
      const s = scripted(b.behaviours);
      const { result, commits } = await run({
        def: b.def,
        state: before,
        event: runFrom(b.main.id, b.greet),
        executors: s.executors,
      });
      expect(texts(commits)[0]).toBe("أهلاً");
      expect(result.state.wait).toMatchObject({ nodeId: b.ask, attempts: 0 });
      expect(result.state.stack).toHaveLength(1);
    },
  );

  test("from a sub-workflow node, the frame pops when it finishes and the conversation goes idle", async () => {
    const b = threeNodeBot();
    const s = scripted(b.behaviours);
    const { result, commits } = await run({
      def: b.def,
      state: state(),
      event: runFrom(b.sub.id, b.subNode),
      executors: s.executors,
    });
    expect(texts(commits)).toEqual(["من الـ sub"]);
    expect(result.status).toBe("completed");
    expect(result.state).toMatchObject({ status: "idle", stack: [] });
  });

  test("an unknown node fails the turn with not_found and names the node", async () => {
    const b = threeNodeBot();
    const missing = nodeId();
    const { result, commits } = await run({ def: b.def, state: state(), event: runFrom(b.main.id, missing) });
    expect(result.status).toBe("failed");
    const [failure] = failures(commits);
    expect(failure).toMatchObject({ code: "not_found", location: { workflowId: b.main.id, nodeId: missing } });
  });

  test("a payload without both ids fails the turn with validation_failed", async () => {
    const b = threeNodeBot();
    const { result, commits } = await run({
      def: b.def,
      state: state(),
      event: event("run_from", { payload: { nodeId: b.greet } }),
    });
    expect(result.status).toBe("failed");
    expect(failures(commits)[0]).toMatchObject({ code: "validation_failed" });
  });
});
