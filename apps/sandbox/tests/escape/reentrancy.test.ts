import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SandboxPool } from "../../src/pool";
import { errorOf, resultOf, runWithHost } from "../../test/host";

/**
 * Escape suite (build plan 3.4, threat T2): re-entrancy. The guest can call the bridge from places
 * the host does not expect: from a getter the host reads, from a toJSON the prelude runs, while the
 * snapshot is taken, or after its own run has ended. None of these may crash the runner, leak a
 * QuickJS handle (which aborts the module), double-settle a promise or reach another exec.
 * This suite only grows.
 */

let pool: SandboxPool;

beforeAll(async () => {
  pool = new SandboxPool({ size: 1 });
  await pool.start();
});

afterAll(async () => {
  await pool?.close();
});

const stillServing = async () => {
  const r = await runWithHost(pool, "return 'ok';");
  expect(resultOf(r.outcome).value).toBe("ok");
  expect(pool.health()).toMatchObject({ live: 1, kills: 0 });
};

describe("calls from places the host reads", () => {
  test("a call made from a toJSON while another call is being encoded", async () => {
    const r = await runWithHost(
      pool,
      "await say({ type: 'custom', name: 'outer', data: { toJSON() { say('inner'); return 1; } } }); return 1;",
      { handlers: { say: () => null } },
    );
    expect(resultOf(r.outcome).value).toBe(1);
    expect(r.calls.map((c) => (c.input as { message: { text?: string; name?: string } }).message)).toEqual([
      { type: "text", text: "inner" },
      { type: "custom", name: "outer", data: 1 },
    ]);
    await stillServing();
  });

  test("a call made from an error's message getter while the host describes the error", async () => {
    const r = await runWithHost(
      pool,
      "const e = new Error('x'); Object.defineProperty(e, 'message', { get() { say('from getter'); return 'm'; } }); throw e;",
      { handlers: { say: () => null } },
    );
    expect(errorOf(r.outcome)).toMatchObject({ code: "code_error", message: "m" });
    await stillServing();
  });

  test("a call made while the snapshot is taken", async () => {
    const r = await runWithHost(
      pool,
      "Object.defineProperty(workflow, 'x', { enumerable: true, get() { say('during snapshot'); return 1; } }); return 2;",
      { handlers: { say: () => null } },
    );
    expect(resultOf(r.outcome)).toMatchObject({ value: 2, scopePatches: { workflow: { set: { x: 1 } } } });
    await stillServing();
  });

  test("a call made from the result's toJSON", async () => {
    const r = await runWithHost(pool, "return { toJSON() { say('late'); log.info('late'); return 3; } };", {
      handlers: { say: () => null },
    });
    expect(resultOf(r.outcome).value).toBe(3);
    await stillServing();
  });

  test("a log made from inside a log argument", async () => {
    const r = await runWithHost(pool, "log.info({ toJSON() { log.info('inner'); return 'outer'; } }); return 1;");
    expect(r.logs.map((l) => l.args[0])).toEqual(["inner", "outer"]);
  });
});

describe("answers the host does not expect", () => {
  test("a second answer to the same call is ignored", async () => {
    const pending = pool.exec(
      {
        execId: "exec_double_answer_2",
        kind: "code",
        source: "return await ai.generate({ instructions: 'x' });",
        timeoutMs: 2_000,
        memoryMb: 64,
      },
      {
        onFrame: (frame) => {
          const f = frame as { t: string; callId: string };
          if (f.t !== "tool_call") return;
          pool.deliver("exec_double_answer_2", { t: "tool_result", callId: f.callId, ok: true, value: "first" });
          pool.deliver("exec_double_answer_2", { t: "tool_result", callId: f.callId, ok: true, value: "second" });
          pool.deliver("exec_double_answer_2", {
            t: "tool_result",
            callId: f.callId,
            ok: false,
            error: { code: "tool_failed", message: "third" },
          });
        },
      },
    );
    expect(resultOf(await pending).value).toBe("first");
    await stillServing();
  });

  test("answers after the exec ended reach nothing", async () => {
    let lateCallId = "";
    const r = await runWithHost(pool, "say('never awaited'); return 'done';", {
      execId: "exec_late",
      answer: false,
      handlers: {},
    });
    lateCallId = r.calls[0]?.callId ?? "";
    expect(resultOf(r.outcome).value).toBe("done");
    expect(pool.deliver("exec_late", { t: "tool_result", callId: lateCallId, ok: true, value: "late" })).toBe(false);
    await stillServing();
  });

  test("an answer for one exec never reaches another, even with the same call id", async () => {
    let forged: boolean | undefined;
    const r = await runWithHost(pool, "return await kb.search('a');", {
      execId: "exec_victim",
      handlers: {
        "kb.search": async () => {
          // Call ids are only unique within an exec; deliver() routes by exec id first.
          forged = pool.deliver("exec_attacker", { t: "tool_result", callId: "call_0", ok: true, value: "forged" });
          return "real";
        },
      },
    });
    expect(forged).toBe(false);
    expect(resultOf(r.outcome).value).toBe("real");
  });
});

describe("floods", () => {
  test("calls made in a loop without awaiting stop at 500 and the run ends at its deadline", async () => {
    const r = await runWithHost(pool, "for (;;) { say('x'); }", { timeoutMs: 300, answer: false });
    expect(errorOf(r.outcome).code).toBe("code_timeout");
    expect(r.calls.length).toBeLessThanOrEqual(16);
    await stillServing();
  });

  test("calls made in a loop with fast answers never exceed 500", async () => {
    const r = await runWithHost(
      pool,
      "const all = []; for (let i = 0; i < 2000; i++) all.push(say('x').catch((e) => e.code)); const out = await Promise.all(all); return out.filter((x) => x === 'code_error').length;",
      { timeoutMs: 20_000, handlers: { say: () => null } },
    );
    expect(resultOf(r.outcome).value).toBe(1500);
    expect(r.calls).toHaveLength(500);
  });

  test("logs made in a loop stop at 200 frames and the run ends at its deadline", async () => {
    const r = await runWithHost(pool, "for (;;) { log.info('x'); }", { timeoutMs: 200 });
    expect(errorOf(r.outcome).code).toBe("code_timeout");
    expect(r.logs.length).toBeLessThanOrEqual(201);
  });
});
