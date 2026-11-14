import type { Frame, WaitSpec } from "@wakeel/contracts";
import { describe, expect, test } from "vitest";
import {
  capture,
  cardId,
  harness,
  linearBot,
  message,
  outcome,
  run,
  say,
  scripted,
  state,
  step,
  texts,
  varId,
} from "./harness";

/** Architecture §4.4 "Persistence" and §4.3: one commit per step, and safe to run again. */

describe("commits", () => {
  test("each step commits once, in order, with contiguous sequence numbers", async () => {
    const [a, b, c] = [cardId(), cardId(), cardId()];
    const bot = linearBot([step(a), step(b), step(c)]);
    const s = scripted({ [a]: () => say("١"), [b]: () => say("٢"), [c]: () => say("٣") });
    const { commits, result, input } = await run({ def: bot.def, executors: s.executors });
    expect(commits.map((x) => x.stepSeq)).toEqual([1, 2, 3]);
    expect(commits.map((x) => x.step?.cardId)).toEqual([a, b, c]);
    expect(commits.map((x) => texts([x]))).toEqual([["١"], ["٢"], ["٣"]]);
    expect(commits.every((x) => x.turnId === input.turnId)).toBe(true);
    // The last step's commit includes the transitions after it: the turn is idle there.
    expect(commits.at(-1)?.state).toEqual(state());
    expect(result).toMatchObject({ stepSeq: 3, messageCount: 3 });
  });

  test("each commit holds the state after its step, not a reference that changes later", async () => {
    const [a, b] = [cardId(), cardId()];
    const v = varId();
    const bot = linearBot([step(a), step(b)], {
      variables: [{ id: v, name: "n", scope: "conversation", type: "number" }],
    });
    const write = (n: number) => () =>
      outcome({ type: "next" }, { writes: [{ scope: "conversation", variableId: v, value: n }] });
    const s = scripted({ [a]: write(1), [b]: write(2) });
    const h = harness();
    const live: unknown[] = [];
    h.ports.commitStep = async (commit) => {
      live.push(commit.state);
    };
    await run({ def: bot.def, h, executors: s.executors });
    expect(live.map((x) => (x as { conversationVars: Record<string, number> }).conversationVars[v])).toEqual([1, 2]);
  });

  test("the inbound event's effects commit with the first step, so a reply cannot be lost", async () => {
    const ask = cardId();
    const into = varId();
    const bot = linearBot([capture(ask, into)], {
      variables: [{ id: into, name: "name", scope: "conversation", type: "string" }],
    });
    const wait: WaitSpec = {
      kind: "capture",
      nodeId: bot.node,
      cardId: ask,
      attempts: 0,
      since: "2026-11-13T08:00:00.000Z",
    };
    const frame: Frame = { workflowId: bot.main.id, nodeId: bot.node, cardIndex: 0, vars: {}, inputs: {} };
    const s = scripted({
      [ask]: () => outcome({ type: "next" }, { writes: [{ scope: "conversation", variableId: into, value: "منى" }] }),
    });
    const { commits } = await run({
      def: bot.def,
      state: state({ status: "waiting_input", wait, stack: [frame] }),
      event: message("منى"),
      executors: s.executors,
    });
    // One commit: the wait is cleared in the same transaction that stores the answer.
    expect(commits).toHaveLength(1);
    expect(commits[0]?.state).toMatchObject({ status: "idle", conversationVars: { [into]: "منى" } });
    expect(commits[0]?.state.wait).toBeUndefined();
  });

  test("changes after the last committed step get a sequence number of their own", async () => {
    const bot = linearBot(
      Array.from({ length: 11 }, () => step()),
      {
        settings: { limits: { stepsPerTurn: 10, turnSeconds: 120 } },
      },
    );
    const s = scripted();
    const { commits } = await run({ def: bot.def, executors: s.executors });
    expect(commits.map((c) => c.stepSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(commits.at(-1)?.step).toBeUndefined();
    expect(commits.at(-1)?.failures[0]?.code).toBe("step_limit_exceeded");
  });

  test("the input is never mutated", async () => {
    const a = cardId();
    const v = varId();
    const bot = linearBot([step(a)], { variables: [{ id: v, name: "n", scope: "user", type: "number" }] });
    const s = scripted({
      [a]: () => outcome({ type: "next" }, { writes: [{ scope: "user", variableId: v, value: 7 }] }),
    });
    const before = state();
    const user = { vars: {}, attributes: { plan: "pro" } };
    const frozen = structuredClone({ before, user });
    await run({ def: bot.def, state: before, user, executors: s.executors });
    expect({ before, user }).toEqual(frozen);
  });
});

describe("resuming after a crash", () => {
  test("continues from the committed state without applying the event again", async () => {
    const [a, b, c] = [cardId(), cardId(), cardId()];
    const bot = linearBot([step(a), step(b), step(c)]);
    // A worker committed steps 1 and 2 (cards a and b), then died.
    const midTurn = state({
      stack: [{ workflowId: bot.main.id, nodeId: bot.node, cardIndex: 2, vars: {}, inputs: {} }],
    });
    const s = scripted();
    const { commits, result } = await run({ def: bot.def, state: midTurn, committedSteps: 2, executors: s.executors });
    expect(s.ran()).toEqual([c]);
    expect(commits.map((x) => x.stepSeq)).toEqual([3]);
    expect(result).toMatchObject({ status: "completed", stepSeq: 3 });
  });

  test("a step that crashed before committing runs again from its start", async () => {
    const [a, b] = [cardId(), cardId()];
    const bot = linearBot([step(a), step(b)]);
    const runs: string[] = [];
    const s = scripted({
      [b]: () => {
        runs.push(b);
        return say("مرة واحدة في الـ transcript");
      },
    });
    const h1 = harness({ loseLeaseAt: 2 });
    await expect(run({ def: bot.def, h: h1, executors: s.executors })).rejects.toThrow("lease lost");
    // Step 1 was committed; the step-2 commit was refused.
    const committed = h1.commits.at(-1);
    expect(committed?.stepSeq).toBe(1);
    const { commits } = await run({
      def: bot.def,
      state: committed?.state,
      committedSteps: committed?.stepSeq,
      executors: s.executors,
    });
    expect(runs).toEqual([b, b]);
    // The re-run produces step 2 again, with the same sequence number, so message ids repeat.
    expect(commits.map((x) => x.stepSeq)).toEqual([2]);
  });
});

describe("a lost lease", () => {
  test("stops the turn: runTurn rejects and nothing else runs or commits", async () => {
    const steps = [cardId(), cardId(), cardId(), cardId()];
    const bot = linearBot(steps.map((id) => step(id)));
    const s = scripted();
    const h = harness({ loseLeaseAt: 2 });
    await expect(run({ def: bot.def, h, executors: s.executors })).rejects.toThrow("lease lost");
    expect(s.ran()).toEqual(steps.slice(0, 2));
    expect(h.commits.map((c) => c.stepSeq)).toEqual([1]);
    // Typing is not switched off by a worker that no longer owns the conversation.
    expect(h.ephemeral.map((e) => e.data.state)).toEqual(["on"]);
  });
});

describe("typing", () => {
  test("is switched on before the first step and off after the turn", async () => {
    const a = cardId();
    const bot = linearBot([step(a)]);
    const h = harness();
    const order: string[] = [];
    const commit = h.ports.commitStep;
    h.ports.commitStep = async (c) => {
      order.push(`commit ${c.stepSeq}`);
      return commit(c);
    };
    const emit = h.ports.emitEphemeral;
    h.ports.emitEphemeral = async (e) => {
      order.push(`typing ${e.data.state}`);
      return emit(e);
    };
    const s = scripted({
      [a]: () => {
        order.push("step");
        return say("أهلاً");
      },
    });
    await run({ def: bot.def, h, executors: s.executors });
    expect(order).toEqual(["typing on", "step", "commit 1", "typing off"]);
  });

  test("is not shown when no step can run", async () => {
    const { ephemeral } = await run({ def: linearBot([step()]).def, state: state({ status: "handed_off" }) });
    expect(ephemeral).toEqual([]);
  });

  test("a failure to deliver it does not affect the turn", async () => {
    const h = harness({ ephemeralFails: true });
    const { result } = await run({ def: linearBot([step()]).def, h, executors: scripted().executors });
    expect(result.status).toBe("completed");
  });
});

describe("a reply after the definition changed", () => {
  test("is not fed to a card other than the one that asked", async () => {
    const [moved, ask] = [cardId(), cardId()];
    const into = varId();
    const bot = linearBot([step(moved), capture(ask, into)]);
    // The conversation waited on `ask` at index 0 of an older version; index 0 is now another card.
    const wait: WaitSpec = {
      kind: "capture",
      nodeId: bot.node,
      cardId: ask,
      attempts: 0,
      since: "2026-11-13T08:00:00.000Z",
    };
    const frame: Frame = { workflowId: bot.main.id, nodeId: bot.node, cardIndex: 0, vars: {}, inputs: {} };
    const s = scripted();
    await run({
      def: bot.def,
      state: state({ status: "waiting_input", wait, stack: [frame] }),
      event: message("منى"),
      executors: s.executors,
    });
    expect(s.calls.map((c) => [c.card.id, c.reply !== undefined])).toEqual([
      [moved, false],
      [ask, false],
    ]);
  });
});
